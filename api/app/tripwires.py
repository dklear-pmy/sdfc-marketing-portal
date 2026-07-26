"""Tripwire accounts: persistent @qa.sdfc.dev profiles that live in Customer.io,
receive real sends into the Mailpit sink, and are asserted on a daily
Cloud Scheduler tick (plus on-demand runs from the portal).

Checks per tripwire (each isolated — a thrown check records WARN, never
aborts the run):
  profile_exists  — the CIO profile is still there
  subscription    — unsubscribed flag matches expectation (unsub-loop detector)
  transport       — anything CIO sent in the last 24h was delivered within
                    15 min (the scenario-005 sent-but-undelivered class)
  sink_arrival    — every delivery CIO claims in the last 24h is present in
                    the Mailpit sink (catches sink/MX drift from the other end)
  quiet           — optional: warn when nothing was sent for max_quiet_days
                    (audience-drift signal for broad-list listeners)

Workspace-level check (recorded under email='_workspace'):
  pmy_test_lint   — no non-PMY-TEST campaign triggers on a pmy_test_* event

Registry + results live in `customerio_state.tripwires` / `tripwire_checks`
(portal-sa is dataset WRITER). Provisioning fires a slug's TEST webhook, the
same proven path the harness runner uses.
"""

import datetime as dt

import requests
from google.cloud import bigquery

from . import mailpit
from .bqstate import client
from .cio import CioClient
from .config import GCP_PROJECT, slug_registry
from .runner import _webhook_url

_DATASET = f"{GCP_PROJECT}.customerio_state"

DELIVERY_DEADLINE_MIN = 15
TRANSPORT_WINDOW_H = 24


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(ts: float | None) -> str | None:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat() if ts else None


# ---- registry ----


def list_tripwires(active_only: bool = False) -> list[dict]:
    where = "WHERE active" if active_only else ""
    rows = client().query(
        f"SELECT * FROM `{_DATASET}.tripwires` {where} ORDER BY created_at"
    ).result()
    out = []
    for r in rows:
        d = dict(r)
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        out.append(d)
    return out


def add_tripwire(
    email: str,
    label: str,
    purpose: str | None,
    *,
    expect_subscribed: bool = True,
    max_quiet_days: int | None = None,
    provision_slug: str | None = None,
    actor: str | None = None,
) -> dict:
    email = email.strip().lower()
    if not email.endswith("@qa.sdfc.dev"):
        raise ValueError("Tripwire emails must be @qa.sdfc.dev (the sink only accepts that domain)")
    if any(t["email"] == email for t in list_tripwires()):
        raise ValueError(f"{email} is already registered")

    provisioned = None
    if provision_slug:
        spec = slug_registry().get(provision_slug)
        if not spec or "test_webhook_secret" not in spec:
            raise ValueError(f"slug '{provision_slug}' has no test webhook to provision through")
        payload = _provision_payload(email, label)
        resp = requests.post(_webhook_url(spec), json=payload, timeout=20)
        if resp.status_code not in (200, 202):
            raise ValueError(f"provisioning webhook HTTP {resp.status_code}: {resp.text[:150]}")
        provisioned = f"webhook HTTP {resp.status_code} via {provision_slug}"

    client().query(
        f"""
        INSERT INTO `{_DATASET}.tripwires`
          (email, label, purpose, expect_subscribed, max_quiet_days, active, created_at, created_by)
        VALUES (@email, @label, @purpose, @expect_sub, @quiet, TRUE, CURRENT_TIMESTAMP(), @actor)
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("email", "STRING", email),
                bigquery.ScalarQueryParameter("label", "STRING", label),
                bigquery.ScalarQueryParameter("purpose", "STRING", purpose),
                bigquery.ScalarQueryParameter("expect_sub", "BOOL", expect_subscribed),
                bigquery.ScalarQueryParameter("quiet", "INT64", max_quiet_days),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
            ]
        ),
    ).result()
    return {"email": email, "provisioned": provisioned}


def _provision_payload(email: str, label: str) -> dict:
    """tb_signup-shaped payload; dedup key derives from the local-part hash so
    re-provisioning the same tripwire is idempotent on CIO's side."""
    now = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    activity_id = 980000000 + (abs(hash(email)) % 1000000)
    return {
        "dedup_key": str(activity_id),
        "email": email,
        "activity_id": activity_id,
        "campaign_title": "San Diego FC / Stay Informed",
        "signup_form_family": "stay_informed",
        "is_world_cup": False,
        "is_new_fan_24h": True,
        "fan_created_at": now,
        "activity_at": now,
        "first_name": "Tripwire",
        "last_name": label,
        "fan_source": "",
        "phone_subscribed": False,
        "has_season_plan": False,
        "postal_code": "92101",
    }


# ---- checks ----


def _check_profile(cio: CioClient, email: str) -> tuple[dict | None, dict]:
    person = cio.customer_by_email(email)
    if not person:
        return None, {"check_name": "profile_exists", "status": "FAIL", "detail": "No CIO profile for this email"}
    return person, {"check_name": "profile_exists", "status": "PASS", "detail": f"cio_id {person['cio_id']}"}


def _check_subscription(cio: CioClient, cio_id: str, expect_subscribed: bool) -> dict:
    customer = cio.customer_attributes(cio_id)
    unsub = bool(customer.get("unsubscribed"))
    ok = unsub != expect_subscribed
    if ok:
        return {"check_name": "subscription", "status": "PASS", "detail": "unsubscribed=false as expected" if expect_subscribed else "unsubscribed=true as expected"}
    if expect_subscribed:
        detail = "Profile is UNSUBSCRIBED but should be subscribed — suppression/unsub-loop event or import overwrote it"
    else:
        detail = "Profile is subscribed but should be unsubscribed"
    return {"check_name": "subscription", "status": "FAIL", "detail": detail}


def _check_transport(messages: list[dict]) -> dict:
    cutoff = _now().timestamp() - TRANSPORT_WINDOW_H * 3600
    recent = [m for m in messages if (m.get("metrics") or {}).get("sent", 0) >= cutoff]
    if not recent:
        return {"check_name": "transport", "status": "PASS", "detail": f"No sends in the last {TRANSPORT_WINDOW_H}h"}
    lost = []
    for m in recent:
        mt = m.get("metrics") or {}
        overdue = _now().timestamp() - mt["sent"] > DELIVERY_DEADLINE_MIN * 60
        if not mt.get("delivered") and not mt.get("bounced") and overdue:
            lost.append(f"'{m.get('subject')}' sent {_iso(mt['sent'])}")
    if lost:
        return {
            "check_name": "transport",
            "status": "FAIL",
            "detail": f"Sent but never delivered (> {DELIVERY_DEADLINE_MIN} min, no bounce): " + "; ".join(lost[:3]),
        }
    return {"check_name": "transport", "status": "PASS", "detail": f"{len(recent)} send(s) in {TRANSPORT_WINDOW_H}h — none lost"}


def _check_sink_arrival(email: str, messages: list[dict]) -> dict:
    cutoff = _now().timestamp() - TRANSPORT_WINDOW_H * 3600
    delivered = [
        m for m in messages if (m.get("metrics") or {}).get("delivered", 0) >= cutoff
    ]
    if not delivered:
        return {"check_name": "sink_arrival", "status": "PASS", "detail": f"No deliveries in the last {TRANSPORT_WINDOW_H}h"}
    sink_subjects = {m.get("Subject") for m in mailpit.search_to(email)}
    missing = [m.get("subject") for m in delivered if m.get("subject") not in sink_subjects]
    if missing:
        return {
            "check_name": "sink_arrival",
            "status": "FAIL",
            "detail": "CIO says delivered but not in the sink: " + "; ".join(f"'{s}'" for s in missing[:3]),
        }
    return {"check_name": "sink_arrival", "status": "PASS", "detail": f"{len(delivered)} deliverie(s) all present in the sink"}


def _check_quiet(messages: list[dict], max_quiet_days: int | None) -> dict | None:
    if not max_quiet_days:
        return None
    last_sent = max(((m.get("metrics") or {}).get("sent") or 0 for m in messages), default=0)
    if not last_sent:
        return {"check_name": "quiet", "status": "WARN", "detail": "Never received a send"}
    days = (_now().timestamp() - last_sent) / 86400
    if days > max_quiet_days:
        return {
            "check_name": "quiet",
            "status": "WARN",
            "detail": f"No sends for {days:.1f}d (threshold {max_quiet_days}d) — audience drift or genuinely quiet period",
        }
    return {"check_name": "quiet", "status": "PASS", "detail": f"Last send {days:.1f}d ago (threshold {max_quiet_days}d)"}


def _check_workspace_lint(cio: CioClient) -> dict:
    campaigns = cio.campaigns()
    offenders = [
        f"{c.get('name')} (id {c.get('id')}, {c.get('state')})"
        for c in campaigns
        if (c.get("event_name") or "").startswith("pmy_test_")
        and "PMY-TEST" not in (c.get("name") or "")
    ]
    if offenders:
        return {
            "check_name": "pmy_test_lint",
            "status": "FAIL",
            "detail": "Non-PMY-TEST campaign(s) triggering on pmy_test_* events: " + "; ".join(offenders[:3]),
        }
    return {"check_name": "pmy_test_lint", "status": "PASS", "detail": f"{len(campaigns)} campaigns checked — no live campaign listens on pmy_test_* events"}


def _guard(fn, *args, check_name: str) -> dict:
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 — a broken dependency must read as WARN, not abort the tick
        return {"check_name": check_name, "status": "WARN", "detail": f"check could not run: {str(e)[:180]}"}


def run_checks(source: str) -> dict:
    cio = CioClient()
    results: list[dict] = []

    for tw in list_tripwires(active_only=True):
        email = tw["email"]
        rows: list[dict] = []
        # profile check returns a tuple, so it gets its own guard inline
        try:
            person, profile_check = _check_profile(cio, email)
        except Exception as e:  # noqa: BLE001
            person, profile_check = None, {
                "check_name": "profile_exists", "status": "WARN", "detail": f"check could not run: {str(e)[:180]}"
            }
        rows.append(profile_check)

        if person:
            rows.append(_guard(_check_subscription, cio, person["cio_id"], tw["expect_subscribed"], check_name="subscription"))
            try:
                messages = cio.customer_messages_page(person["cio_id"], limit=50).get("messages", [])
            except Exception as e:  # noqa: BLE001
                messages = []
                rows.append({"check_name": "transport", "status": "WARN", "detail": f"delivery ledger unavailable: {str(e)[:150]}"})
            else:
                rows.append(_guard(_check_transport, messages, check_name="transport"))
                rows.append(_guard(_check_sink_arrival, email, messages, check_name="sink_arrival"))
                quiet = _guard(_check_quiet, messages, tw["max_quiet_days"], check_name="quiet")
                if quiet:
                    rows.append(quiet)

        for r in rows:
            r["email"] = email
        results.extend(rows)

    ws = _guard(_check_workspace_lint, cio, check_name="pmy_test_lint")
    ws["email"] = "_workspace"
    results.append(ws)

    _record(results, source)
    failing = sum(1 for r in results if r["status"] == "FAIL")
    warning = sum(1 for r in results if r["status"] == "WARN")
    return {"checked_at": _now().isoformat(), "checks": len(results), "fail": failing, "warn": warning, "results": results}


def _record(results: list[dict], source: str) -> None:
    if not results:
        return
    rows = [
        {
            "checked_at": _now().isoformat(),
            "email": r["email"],
            "check_name": r["check_name"],
            "status": r["status"],
            "detail": r.get("detail"),
            "source": source,
        }
        for r in results
    ]
    errors = client().insert_rows_json(f"{_DATASET}.tripwire_checks", rows)
    if errors:
        raise RuntimeError(f"tripwire_checks insert failed: {errors}")


# ---- read side ----

_RANK = {"FAIL": 0, "WARN": 1, "PASS": 2}


def state() -> dict:
    tripwires = list_tripwires()
    latest = list(
        client()
        .query(
            f"""
            SELECT email, check_name, status, detail, checked_at FROM (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY email, check_name ORDER BY checked_at DESC) rn
              FROM `{_DATASET}.tripwire_checks`
            ) WHERE rn = 1
            """
        )
        .result()
    )
    by_email: dict[str, list[dict]] = {}
    last_run = None
    for r in latest:
        d = dict(r)
        d["checked_at"] = d["checked_at"].isoformat()
        by_email.setdefault(d.pop("email"), []).append(d)
        last_run = max(last_run or d["checked_at"], d["checked_at"])

    def overall(checks: list[dict]) -> str:
        return min((c["status"] for c in checks), key=lambda s: _RANK[s]) if checks else "UNCHECKED"

    out = []
    for tw in tripwires:
        checks = sorted(by_email.get(tw["email"], []), key=lambda c: c["check_name"])
        out.append({**tw, "overall": overall(checks) if tw["active"] else "INACTIVE", "checks": checks})

    ws_checks = by_email.get("_workspace", [])
    return {
        "tripwires": out,
        "workspace": {"overall": overall(ws_checks), "checks": ws_checks},
        "last_run_at": last_run,
    }


def history(limit: int = 100, email: str | None = None) -> list[dict]:
    limit = max(1, min(limit, 500))
    where, params = "", []
    if email:
        where = "WHERE email = @email"
        params = [bigquery.ScalarQueryParameter("email", "STRING", email)]
    rows = client().query(
        f"""
        SELECT checked_at, email, check_name, status, detail, source
        FROM `{_DATASET}.tripwire_checks` {where}
        ORDER BY checked_at DESC LIMIT {limit}
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    out = []
    for r in rows:
        d = dict(r)
        d["checked_at"] = d["checked_at"].isoformat()
        out.append(d)
    return out
