"""Customer activity dashboard: live Customer.io profile merged with the
warehouse reverse-ETL source.

Warehouse side (BQ, dataset-ACL READER on customerio_gold only):
  - `fan_attributes` — full analytics universe, one row per person, keyed and
    clustered by email (point lookup scans ~15 MB).
  - `fan_attributes_cio_sync` — the EXACT payload shape CIO's BigQuery Data In
    connector ingests. Attribute names mirror CIO attribute names, so a
    per-attribute diff against the live profile is meaningful. A person absent
    from this view but present in fan_attributes is excluded from sync by the
    view's main arm (unsubscribed, with no heal/opt-out-push flag active).

CIO side (App API): profile search, attributes + per-attribute write
timestamps, segments. Activity stream and delivery ledger are paged
separately (see activities_page / messages_page).
"""

import datetime as dt
import decimal
from concurrent.futures import ThreadPoolExecutor

from google.cloud import bigquery

from .bqstate import client
from .cio import CioClient
from .config import GCP_PROJECT

_GOLD = f"{GCP_PROJECT}.customerio_gold"

# Segment-envelope plumbing in the sync view — not person attributes.
_PAYLOAD_PLUMBING = {"userId", "email", "timestamp", "messageId", "updated_at_unix", "customerio_id"}
# CIO keys that identify rather than describe the person, or CIO internals.
_CIO_SKIP = {"email", "cio_id", "id"}
_CIO_INTERNAL_PREFIX = "_cio_"


def _bq_row(table: str, email: str) -> dict | None:
    rows = list(
        client()
        .query(
            f"SELECT * FROM `{_GOLD}.{table}` WHERE email = @email LIMIT 1",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", email)]
            ),
        )
        .result()
    )
    return dict(rows[0]) if rows else None


def _table_built_at() -> str | None:
    try:
        return client().get_table(f"{_GOLD}.fan_attributes").modified.isoformat()
    except Exception:
        return None


def _json_safe(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, float) and v != v:  # NaN
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return v


def _safe_dict(d: dict | None) -> dict | None:
    return {k: _json_safe(v) for k, v in d.items()} if d is not None else None


def _norm(v) -> str:
    """Canonical string for tolerant equality: bools, numerics (1600.0 == "1600"),
    ISO dates/timestamps regardless of source-side serialization."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dt.datetime, dt.date)):
        v = v.isoformat()
    if isinstance(v, (int, float, decimal.Decimal)):
        return f"{float(v):.10g}"
    s = str(v).strip()
    # Literal "None"/"null" strings are data noise (the platform's known
    # 'None'-leak class, and CIO echoes them back) — treat as empty.
    if s.lower() in ("none", "null"):
        return ""
    if s.lower() in ("true", "false"):
        return s.lower()
    try:
        return f"{float(s):.10g}"
    except ValueError:
        pass
    try:  # "2026-03-01T00:00:00Z" vs "2026-03-01 00:00:00+00:00"
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return s


def _compare(payload: dict, base_row: dict, customer: dict) -> tuple[list[dict], dict]:
    attrs = customer.get("attributes") or {}
    stamps = customer.get("timestamps") or {}
    rows: list[dict] = []

    def stamp(name: str) -> str | None:
        ts = stamps.get(name)
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat() if ts else None

    for name, wh_val in payload.items():
        if name in _PAYLOAD_PLUMBING:
            continue
        if name == "unsubscribed":
            # The sync payload masks FALSE to NULL (resubscribe-loop guard);
            # diff the raw warehouse flag against CIO's reserved flag instead.
            wh_val, cio_val = base_row.get("unsubscribed"), customer.get("unsubscribed")
        else:
            cio_val = attrs.get(name)
        wh_n, cio_n = _norm(wh_val), _norm(cio_val)
        if not wh_n and not cio_n:
            status = "empty"
        elif wh_n == cio_n:
            status = "match"
        elif not cio_n:
            status = "pending"  # warehouse has it, CIO doesn't yet
        elif not wh_n:
            status = "cio_only"  # set in CIO (trigger webhook / in-app), not in warehouse
        else:
            status = "differs"
        rows.append(
            {
                "name": name,
                "warehouse": _json_safe(wh_val),
                "cio": _json_safe(cio_val),
                "status": status,
                "cio_updated_at": stamp(name),
            }
        )

    seen = {r["name"] for r in rows} | _PAYLOAD_PLUMBING
    for name, cio_val in attrs.items():
        if name in seen or name in _CIO_SKIP or name.startswith(_CIO_INTERNAL_PREFIX):
            continue
        rows.append(
            {
                "name": name,
                "warehouse": None,
                "cio": _json_safe(cio_val),
                "status": "cio_only" if _norm(cio_val) else "empty",
                "cio_updated_at": stamp(name),
            }
        )

    order = {"differs": 0, "pending": 1, "cio_only": 2, "match": 3, "empty": 4}
    rows.sort(key=lambda r: (order[r["status"]], r["name"]))
    summary: dict = {}
    for r in rows:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return rows, summary


def _cio_side(email: str) -> dict:
    cio = CioClient()
    found = cio.customer_by_email(email)
    if not found:
        return {"found": False}
    cio_id = found["cio_id"]
    customer = cio.customer_attributes(cio_id)
    segments = cio.customer_segments(cio_id)
    stamps = customer.get("timestamps") or {}
    last_write = max((ts for ts in stamps.values() if ts), default=None)
    return {
        "found": True,
        "cio_id": cio_id,
        "id": found.get("id") or None,
        "unsubscribed": customer.get("unsubscribed"),
        # id is CIO's own numeric segment id — the stable handle people use in
        # the CIO UI and API, and the disambiguator for duplicate names.
        "segments": [{"id": s.get("id"), "name": s.get("name") or ""} for s in segments],
        "customer": customer,
        "last_attribute_write": (
            dt.datetime.fromtimestamp(last_write, dt.timezone.utc).isoformat()
            if last_write
            else None
        ),
    }


def lookup(email: str) -> dict:
    email = email.strip().lower()
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_cio = ex.submit(_cio_side, email)
        f_base = ex.submit(_bq_row, "fan_attributes", email)
        f_payload = ex.submit(_bq_row, "fan_attributes_cio_sync", email)
        f_built = ex.submit(_table_built_at)
        cio_side, base_row, payload = f_cio.result(), f_base.result(), f_payload.result()
        built_at = f_built.result()

    customer = cio_side.pop("customer", {})
    in_view = payload is not None
    excluded_reason = None
    if base_row is not None and not in_view:
        excluded_reason = (
            "Unsubscribed — excluded by the sync view's main arm "
            "(no resuppression or opt-out-push flag active)"
        )

    # In the sync view but no CIO profile yet = a fan awaiting their first
    # pull. The Data-In connector pulls hourly, with writes observed landing
    # within ~15 min of the top of the hour — so the ETA is :15 past the next.
    first_sync_eta = None
    if in_view and not cio_side.get("found"):
        now = dt.datetime.now(dt.timezone.utc)
        first_sync_eta = (
            now.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1, minutes=15)
        ).isoformat()

    comparison: list[dict] = []
    summary: dict = {}
    if in_view:
        # With no CIO profile yet, every populated attribute reads "pending" —
        # exactly right for a fan awaiting their first hourly sync.
        comparison, summary = _compare(payload, base_row or {}, customer)

    return {
        "email": email,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "cio": {
            **cio_side,
            "attributes": _safe_dict(customer.get("attributes")) if cio_side.get("found") else None,
        },
        "warehouse": {
            "found": base_row is not None,
            "updated_at": _json_safe(base_row.get("updated_at")) if base_row else None,
            "table_built_at": built_at,
            "row": _safe_dict(base_row),
        },
        "sync": {
            "in_sync_view": in_view,
            "excluded_reason": excluded_reason,
            "first_sync_eta": first_sync_eta,
            "comparison": comparison,
            "summary": summary,
        },
    }


_LIST_COLUMNS = (
    "email, full_name, sprocket_macro, stm_product, stm_type, ticketing_member_status, "
    "matches_attended_2026, matches_attended_lifetime, last_attendance_date, "
    "lifetime_spend, tb_fan_source, updated_at"
)


def list_fans(q: str | None, limit: int = 20, offset: int = 0) -> dict:
    """Latest active fans: subscribed, ordered by most recent attribute change
    (updated_at only moves when row content changes — it is the sync watermark,
    not the build time). Free-text q matches email, name, TM account and
    postal code."""
    where = ["unsubscribed = FALSE"]
    params: list[bigquery.ScalarQueryParameter] = [
        bigquery.ScalarQueryParameter("limit", "INT64", limit),
        bigquery.ScalarQueryParameter("offset", "INT64", offset),
    ]
    if q:
        where.append(
            "(STRPOS(LOWER(email), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(COALESCE(full_name, '')), LOWER(@q)) > 0"
            " OR STRPOS(COALESCE(tm_acct_id, ''), @q) > 0"
            " OR STRPOS(COALESCE(postal_code, ''), @q) > 0)"
        )
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    cond = " AND ".join(where)

    rows = [
        _safe_dict(dict(r))
        for r in client()
        .query(
            f"""
            SELECT {_LIST_COLUMNS}
            FROM `{_GOLD}.fan_attributes`
            WHERE {cond}
            ORDER BY updated_at DESC
            LIMIT @limit OFFSET @offset
            """,
            job_config=bigquery.QueryJobConfig(query_parameters=params),
        )
        .result()
    ]
    total = list(
        client()
        .query(
            f"SELECT COUNT(*) AS n FROM `{_GOLD}.fan_attributes` WHERE {cond}",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[p for p in params if p.name == "q"]
            ),
        )
        .result()
    )[0].n
    return {"fans": rows, "total": total, "limit": limit, "offset": offset}


_LEDGER = f"{GCP_PROJECT}.customerdata_gold.customer_status_ledger"
# The live union view: hourly-materialized customer_events + the two real-time
# arms (CIO webhook staging, TB 5-minute poll over bronze externals). Reading
# it is why portal-sa carries READER on customerio_webhooks/tradablebits_bronze
# and objectViewer on gs://sdfc-dev-bronze (granted 2026-07-29, Dean's call).
_EVENTS = f"{GCP_PROJECT}.customerdata_silver.vw_customer_events_live"


def fan_ledger(email: str, limit: int = 25, offset: int = 0, q: str | None = None) -> dict:
    """Warehouse activity ledger for one fan: status-domain rows from
    customer_status_ledger (daily build) plus a page of events from the live
    union view — fresh to ~5 minutes via the CIO webhook and TB polling arms.
    `q` filters events on activity name, source system and event details;
    the status chips always show the full current state."""
    email = email.strip().lower()
    eparam = [bigquery.ScalarQueryParameter("email", "STRING", email)]

    event_where = "customer = @email"
    event_params = [*eparam]
    if q:
        event_where += (
            " AND (STRPOS(LOWER(activity), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(IFNULL(source_system, '')), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(TO_JSON_STRING(feature_json)), LOWER(@q)) > 0)"
        )
        event_params.append(bigquery.ScalarQueryParameter("q", "STRING", q))

    statuses = [
        _safe_dict(dict(r))
        for r in client()
        .query(
            f"SELECT * FROM `{_LEDGER}` WHERE email = @email ORDER BY status_domain",
            job_config=bigquery.QueryJobConfig(query_parameters=eparam),
        )
        .result()
    ]
    events = [
        _safe_dict(dict(r))
        for r in client()
        .query(
            f"""
            SELECT event_id, ts, activity, source_system, is_system_echo,
                   revenue_impact, TO_JSON_STRING(feature_json) AS feature_json
            FROM `{_EVENTS}`
            WHERE {event_where}
            ORDER BY ts DESC
            LIMIT @limit OFFSET @offset
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[
                    *event_params,
                    bigquery.ScalarQueryParameter("limit", "INT64", limit),
                    bigquery.ScalarQueryParameter("offset", "INT64", offset),
                ]
            ),
        )
        .result()
    ]
    return {
        "email": email,
        "statuses": statuses,
        "events": events,
        "limit": limit,
        "offset": offset,
        "has_more": len(events) == limit,
    }


def activities_page(cio_id: str, limit: int, start: str | None) -> dict:
    page = CioClient().customer_activities_page(cio_id, limit=limit, start=start)
    return {"activities": page.get("activities", []), "next": page.get("next") or None}


def messages_page(cio_id: str, limit: int, start: str | None) -> dict:
    page = CioClient().customer_messages_page(cio_id, limit=limit, start=start)
    return {"messages": page.get("messages", []), "next": page.get("next") or None}
