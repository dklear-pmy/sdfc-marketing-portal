"""Pipeline Spend: reads over platform_ops (written hourly by the bq-spend-monitor
Cloud Run job in sdfc-platform/external_cloud_runs/bq_spend_monitor) plus the
three writes the portal owns: acknowledge a finding, accept a baseline version,
edit the two alert recipient lists.

Pure computation (series, tiles, state labels) is kept free of BigQuery so the
tests can pin it down without credentials."""

from __future__ import annotations

import datetime as dt
import re
from statistics import median
from zoneinfo import ZoneInfo

import requests
from google.cloud import bigquery

from .bqstate import client
from .config import GCP_PROJECT

_DATASET = f"{GCP_PROJECT}.platform_ops"
PT = ZoneInfo("America/Los_Angeles")
DAYS_PER_MONTH = 30.4
LISTS = ("spend_critical", "spend_digest")
PLATFORM_FROM = "SDFC Platform <alerts@sdfc.dev>"
_POSTMARK = "https://api.postmarkapp.com/email"


def _q(sql: str, **params) -> list[dict]:
    qp = []
    for k, v in params.items():
        if isinstance(v, bool):
            qp.append(bigquery.ScalarQueryParameter(k, "BOOL", v))
        elif isinstance(v, int):
            qp.append(bigquery.ScalarQueryParameter(k, "INT64", v))
        elif isinstance(v, float):
            qp.append(bigquery.ScalarQueryParameter(k, "FLOAT64", v))
        elif isinstance(v, dt.datetime):
            qp.append(bigquery.ScalarQueryParameter(k, "TIMESTAMP", v))
        else:
            qp.append(bigquery.ScalarQueryParameter(k, "STRING", v))
    rows = client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp)).result()
    return [dict(r) for r in rows]


def _iso(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    return v


def _clean(row: dict) -> dict:
    return {k: _iso(v) for k, v in row.items()}


# ---------------------------------------------------------------- pure computation
def hour_baselines(hourly: list[dict], now: dt.datetime) -> dict[int, float]:
    """Median spend per UTC hour-of-day over [now-35d, now-7d), the reference for the heatmap."""
    buckets: dict[int, list[float]] = {}
    lo, hi = now - dt.timedelta(days=35), now - dt.timedelta(days=7)
    for r in hourly:
        h = r["hour"]
        if lo <= h < hi:
            buckets.setdefault(h.hour, []).append(float(r["usd"]))
    return {k: median(v) for k, v in buckets.items() if v}


def heatmap_cells(hourly: list[dict], baselines: dict[int, float], now: dt.datetime) -> list[dict]:
    """One cell per hour of the last 7 full-or-partial days (newest day last)."""
    start = (now - dt.timedelta(days=7)).replace(minute=0, second=0, microsecond=0)
    by_hour = {r["hour"]: float(r["usd"]) for r in hourly if r["hour"] >= start}
    cells = []
    h = start
    end = now.replace(minute=0, second=0, microsecond=0)
    while h < end:
        actual = by_hour.get(h)
        base = baselines.get(h.hour)
        cells.append({
            "hour": h.isoformat(),
            "hour_pt": h.astimezone(PT).strftime("%a %-m/%-d %-I %p"),
            "actual": actual,
            "baseline": base,
            "ratio": (actual / base) if actual is not None and base else None,
        })
        h += dt.timedelta(hours=1)
    return cells


def daily_totals_pt(hourly: list[dict]) -> dict[dt.date, float]:
    out: dict[dt.date, float] = {}
    for r in hourly:
        d = r["hour"].astimezone(PT).date()
        out[d] = out.get(d, 0.0) + float(r["usd"])
    return out


def tiles(hourly: list[dict], baselines: dict[int, float], approved_per_day: float, now: dt.datetime) -> dict:
    today = now.astimezone(PT).date()
    daily = daily_totals_pt(hourly)
    today_hours = [r for r in hourly if r["hour"].astimezone(PT).date() == today]
    today_so_far = sum(float(r["usd"]) for r in today_hours)
    expected_so_far = sum(baselines.get(r["hour"].hour, 0.0) for r in today_hours)
    yesterday = daily.get(today - dt.timedelta(days=1), 0.0)
    last7 = [daily.get(today - dt.timedelta(days=i), 0.0) for i in range(1, 8)]
    mtd = sum(v for d, v in daily.items() if d.year == today.year and d.month == today.month and d < today)
    prev_end = today.replace(day=1) - dt.timedelta(days=1)
    last_month_same_point = sum(v for d, v in daily.items()
                                if d.year == prev_end.year and d.month == prev_end.month and d.day < today.day)
    return {
        "today_so_far": today_so_far,
        "expected_so_far": expected_so_far,
        "yesterday": yesterday,
        "approved_per_day": approved_per_day,
        "mtd": mtd,
        "last_month_same_point": last_month_same_point,
        "projected_month": (sum(last7) / 7.0) * DAYS_PER_MONTH if any(last7) else 0.0,
        "daily_14": [{"day_pt": (today - dt.timedelta(days=i)).isoformat(),
                      "usd": daily.get(today - dt.timedelta(days=i), 0.0)} for i in range(14, 0, -1)],
    }


def dag_state(reg_state: str | None, version: dict | None, open_findings: int) -> str:
    """learning | armed | unreviewed_change | review, derived the same way the job does."""
    if version and version.get("status") == "learning":
        return "learning"
    if reg_state == "unreviewed_change":
        return "unreviewed_change"
    if open_findings:
        return "review"
    return reg_state or "armed"


# ---------------------------------------------------------------- reads
def summary(now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    hourly = _q(
        f"SELECT hour, SUM(usd) AS usd FROM `{_DATASET}.hourly_spend` "
        f"WHERE hour >= TIMESTAMP_SUB(@now, INTERVAL 62 DAY) AND hour < @now GROUP BY hour ORDER BY hour",
        now=now,
    )
    approved = _q(
        f"""SELECT COALESCE(SUM(usd_per_day), 0) AS usd FROM (
              SELECT dag_id, usd_per_day FROM `{_DATASET}.dag_baseline_versions` WHERE accepted_at IS NOT NULL
              QUALIFY ROW_NUMBER() OVER (PARTITION BY dag_id ORDER BY version DESC) = 1)"""
    )[0]["usd"]
    findings = _q(
        f"SELECT severity, COUNT(*) AS n FROM `{_DATASET}.findings` WHERE status IN ('open','acknowledged') GROUP BY severity"
    )
    awaiting = _q(f"SELECT COUNT(*) AS n FROM `{_DATASET}.dag_registry` WHERE state = 'unreviewed_change'")[0]["n"]
    last_run = _q(f"SELECT * FROM `{_DATASET}.monitor_runs` ORDER BY run_at DESC LIMIT 1")
    baselines = hour_baselines(hourly, now)
    return {
        "tiles": {**tiles(hourly, baselines, float(approved), now),
                  "open_findings": sum(int(r["n"]) for r in findings),
                  "critical_findings": sum(int(r["n"]) for r in findings if r["severity"] == "critical"),
                  "awaiting_acceptance": int(awaiting)},
        "heatmap": heatmap_cells(hourly, baselines, now),
        "last_run": _clean(last_run[0]) if last_run else None,
        "generated_at": now.isoformat(),
    }


def dags(now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    rows = _q(
        f"""
        SELECT r.dag_id, r.schedule, r.is_paused, r.tags, r.cloud_run_jobs, r.first_seen, r.last_seen, r.state AS reg_state,
               v.version, v.status AS v_status, v.learning_until, v.usd_per_day AS baseline_usd_per_day,
               v.prev_usd_per_day, v.runs_per_day_expected, v.runs_per_day AS baseline_runs_per_day,
               v.accepted_at, v.accepted_by, v.change_reason
        FROM `{_DATASET}.dag_registry` r
        LEFT JOIN (
          SELECT * FROM `{_DATASET}.dag_baseline_versions` WHERE status IN ('learning','armed')
          QUALIFY ROW_NUMBER() OVER (PARTITION BY dag_id ORDER BY version DESC) = 1
        ) v USING (dag_id)
        ORDER BY r.dag_id
        """
    )
    daily = _q(
        f"SELECT dag_id, day_pt, usd, runs FROM `{_DATASET}.vw_dag_daily` "
        f"WHERE day_pt >= DATE_SUB(DATE(@now, 'America/Los_Angeles'), INTERVAL 8 DAY) ORDER BY day_pt",
        now=now,
    )
    open_f = _q(
        f"SELECT dag_id, COUNT(*) AS n, COUNTIF(severity = 'critical') AS critical FROM `{_DATASET}.findings` "
        f"WHERE status IN ('open','acknowledged') AND dag_id IS NOT NULL GROUP BY dag_id"
    )
    by_dag_daily: dict[str, list[dict]] = {}
    for d in daily:
        by_dag_daily.setdefault(d["dag_id"], []).append({"day_pt": d["day_pt"].isoformat(), "usd": float(d["usd"]), "runs": int(d["runs"] or 0)})
    fmap = {f["dag_id"]: f for f in open_f}
    today = now.astimezone(PT).date()
    out = []
    for r in rows:
        series = [d for d in by_dag_daily.get(r["dag_id"], []) if d["day_pt"] < today.isoformat()][-7:]
        avg7 = (sum(d["usd"] for d in series) / len(series)) if series else 0.0
        runs7 = (sum(d["runs"] for d in series) / len(series)) if series else 0.0
        f = fmap.get(r["dag_id"], {})
        version = {"status": r["v_status"]} if r["v_status"] else None
        out.append({
            **_clean({k: r[k] for k in ("dag_id", "schedule", "is_paused", "tags", "cloud_run_jobs", "first_seen", "last_seen",
                                        "version", "learning_until", "accepted_at", "accepted_by", "change_reason")}),
            "state": dag_state(r["reg_state"], version, int(f.get("n", 0))),
            "baseline_usd_per_day": r["baseline_usd_per_day"],
            "prev_usd_per_day": r["prev_usd_per_day"],
            "runs_per_day_expected": r["runs_per_day_expected"],
            "baseline_runs_per_day": r["baseline_runs_per_day"],
            "usd_per_day_7d": avg7,
            "runs_per_day_7d": runs7,
            "projected_month": avg7 * DAYS_PER_MONTH,
            "open_findings": int(f.get("n", 0)),
            "critical_findings": int(f.get("critical", 0)),
            "series": series,
        })
    # Non-Dataform principals (Arkero SA, people, other jobs) as their own rows so totals reconcile.
    principals = []
    for dag_id, series in by_dag_daily.items():
        if dag_id.startswith("principal:") or dag_id == "unattributed":
            s = [d for d in series if d["day_pt"] < today.isoformat()][-7:]
            avg7 = (sum(d["usd"] for d in s) / len(s)) if s else 0.0
            principals.append({"dag_id": dag_id, "usd_per_day_7d": avg7, "projected_month": avg7 * DAYS_PER_MONTH, "series": s})
    principals.sort(key=lambda p: -p["usd_per_day_7d"])
    return {"dags": out, "principals": principals, "generated_at": now.isoformat()}


def dag_detail(dag_id: str, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    reg = _q(f"SELECT * FROM `{_DATASET}.dag_registry` WHERE dag_id = @dag_id", dag_id=dag_id)
    if not reg:
        raise KeyError(dag_id)
    versions = _q(f"SELECT * FROM `{_DATASET}.dag_baseline_versions` WHERE dag_id = @dag_id ORDER BY version DESC", dag_id=dag_id)
    hourly = _q(
        f"SELECT hour, SUM(usd) AS usd, SUM(bytes_billed) AS bytes_billed, COUNT(DISTINCT run_key) AS runs "
        f"FROM `{_DATASET}.vw_hourly_spend_attributed` WHERE dag_id = @dag_id AND hour >= TIMESTAMP_SUB(@now, INTERVAL 28 DAY) "
        f"GROUP BY hour ORDER BY hour", dag_id=dag_id, now=now,
    )
    tables7 = _q(
        f"""
        SELECT table_key, action_type, COUNT(DISTINCT run_key) AS runs, SUM(usd) / 7 AS usd_per_day,
               APPROX_QUANTILES(bytes_billed, 2)[OFFSET(1)] / POW(1024, 3) AS gib_per_run_p50
        FROM (
          SELECT table_key, ANY_VALUE(action_type) AS action_type, run_key,
                 SUM(bytes_billed) AS bytes_billed, SUM(usd) AS usd
          FROM `{_DATASET}.vw_hourly_spend_attributed`
          WHERE dag_id = @dag_id AND table_key IS NOT NULL AND hour >= TIMESTAMP_SUB(@now, INTERVAL 7 DAY)
          GROUP BY table_key, run_key
        )
        GROUP BY table_key, action_type ORDER BY usd_per_day DESC
        """, dag_id=dag_id, now=now,
    )
    runs = _q(
        f"""
        SELECT i.invocation_id, i.dag_run_id, i.tag, i.compile_sha, i.started_at, i.ended_at, i.state, i.source,
               COALESCE(SUM(h.usd), 0) AS usd, COALESCE(SUM(h.bytes_billed), 0) AS bytes_billed
        FROM `{_DATASET}.invocation_index` i LEFT JOIN `{_DATASET}.hourly_spend` h USING (invocation_id)
        WHERE i.dag_id = @dag_id AND i.indexed_at >= TIMESTAMP_SUB(@now, INTERVAL 14 DAY)
        GROUP BY 1,2,3,4,5,6,7,8 ORDER BY i.started_at DESC LIMIT 48
        """, dag_id=dag_id, now=now,
    )
    sha_changes = _q(
        f"SELECT compile_sha, MIN(started_at) AS first_seen FROM `{_DATASET}.invocation_index` "
        f"WHERE dag_id = @dag_id AND compile_sha IS NOT NULL AND started_at >= TIMESTAMP_SUB(@now, INTERVAL 28 DAY) "
        f"GROUP BY compile_sha ORDER BY first_seen", dag_id=dag_id, now=now,
    )
    findings = _q(
        f"SELECT * FROM `{_DATASET}.findings` WHERE dag_id = @dag_id AND first_seen >= TIMESTAMP_SUB(@now, INTERVAL 60 DAY) "
        f"ORDER BY first_seen DESC", dag_id=dag_id, now=now,
    )
    current = next((v for v in versions if v["status"] in ("learning", "armed")), None)
    base_tables = {}
    if current and current.get("per_table"):
        pt = current["per_table"]
        base_tables = pt if isinstance(pt, dict) else {}
    table_rows = []
    for t in tables7:
        b = base_tables.get(t["table_key"], {})
        base_gib = b.get("gib_per_run_p50")
        table_rows.append({**_clean(t), "baseline_gib_per_run": base_gib, "baseline_usd_per_day": b.get("usd_per_day"),
                           "gib_ratio": (float(t["gib_per_run_p50"]) / base_gib) if base_gib else None,
                           "in_baseline": t["table_key"] in base_tables})
    open_n = sum(1 for f in findings if f["status"] in ("open", "acknowledged"))
    return {
        "dag": {**_clean(reg[0]), "state": dag_state(reg[0]["state"], current, open_n)},
        "versions": [_clean({**v, "per_table": None}) for v in versions],
        "current_version": _clean({**current, "per_table": None}) if current else None,
        "tables": table_rows,
        "hourly": [_clean(h) for h in hourly],
        "runs": [_clean(r) for r in runs],
        "compile_changes": [_clean(s) for s in sha_changes],
        "findings": [_clean(f) for f in findings],
        "generated_at": now.isoformat(),
    }


def findings(status: str = "open", limit: int = 200) -> list[dict]:
    where = {"open": "status IN ('open','acknowledged')", "all": "TRUE", "resolved": "status IN ('resolved','accepted')"}.get(status, "status IN ('open','acknowledged')")
    rows = _q(f"SELECT * FROM `{_DATASET}.findings` WHERE {where} ORDER BY severity = 'critical' DESC, last_seen DESC LIMIT @limit", limit=limit)
    return [_clean(r) for r in rows]


# ---------------------------------------------------------------- writes
def ack_finding(finding_id: str, actor: str, note: str | None) -> dict:
    n = client().query(
        f"UPDATE `{_DATASET}.findings` SET status = 'acknowledged', acted_by = @actor, acted_at = CURRENT_TIMESTAMP(), note = @note "
        f"WHERE finding_id = @fid AND status = 'open'",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("fid", "STRING", finding_id),
            bigquery.ScalarQueryParameter("actor", "STRING", actor),
            bigquery.ScalarQueryParameter("note", "STRING", note),
        ]),
    ).result()
    return {"finding_id": finding_id, "acknowledged": True}


def accept_baseline(dag_id: str, actor: str, note: str | None) -> dict:
    cur = _q(f"SELECT version, status FROM `{_DATASET}.dag_baseline_versions` WHERE dag_id = @dag_id AND status IN ('learning','armed') "
             f"ORDER BY version DESC LIMIT 1", dag_id=dag_id)
    if not cur:
        raise ValueError(f"{dag_id} has no live baseline version")
    if cur[0]["status"] != "armed":
        raise ValueError(f"{dag_id} is still learning; accept once the baseline is finalized")
    version = int(cur[0]["version"])
    params = [bigquery.ScalarQueryParameter("dag_id", "STRING", dag_id), bigquery.ScalarQueryParameter("v", "INT64", version),
              bigquery.ScalarQueryParameter("actor", "STRING", actor)]
    cfg = bigquery.QueryJobConfig(query_parameters=params)
    client().query(f"UPDATE `{_DATASET}.dag_baseline_versions` SET accepted_by = @actor, accepted_at = CURRENT_TIMESTAMP() "
                   f"WHERE dag_id = @dag_id AND version = @v", job_config=cfg).result()
    client().query(f"UPDATE `{_DATASET}.findings` SET status = 'accepted', acted_by = @actor, acted_at = CURRENT_TIMESTAMP(), note = @note "
                   f"WHERE dag_id = @dag_id AND kind IN ('schedule_changed','new_dag') AND status IN ('open','acknowledged')",
                   job_config=bigquery.QueryJobConfig(query_parameters=params + [bigquery.ScalarQueryParameter("note", "STRING", note)])).result()
    client().query(f"UPDATE `{_DATASET}.dag_registry` SET state = 'armed' WHERE dag_id = @dag_id AND state = 'unreviewed_change'",
                   job_config=cfg).result()
    return {"dag_id": dag_id, "version": version, "accepted_by": actor}


# ---------------------------------------------------------------- recipient lists
def valid_list(name: str) -> str:
    if name not in LISTS:
        raise ValueError(f"Unknown list {name!r}; valid: {list(LISTS)}")
    return name


def list_recipients() -> dict:
    rows = _q(f"SELECT list_name, email, label, added_by, added_at FROM `{_DATASET}.alert_recipients` WHERE active ORDER BY list_name, added_at")
    out = {l: [] for l in LISTS}
    for r in rows:
        out.setdefault(r["list_name"], []).append(_clean(r))
    fallback = _q(f"SELECT value FROM `{_DATASET}.config` WHERE key = 'fallback_email'")
    return {"lists": out, "fallback": fallback[0]["value"] if fallback else None}


def add_recipient(list_name: str, email: str, label: str | None, actor: str | None) -> dict:
    valid_list(list_name)
    client().query(
        f"""
        MERGE `{_DATASET}.alert_recipients` t USING (SELECT @l AS list_name, @email AS email) s
        ON t.list_name = s.list_name AND t.email = s.email
        WHEN MATCHED THEN UPDATE SET active = TRUE, label = @label
        WHEN NOT MATCHED THEN INSERT (list_name, email, label, added_by, added_at, active) VALUES (@l, @email, @label, @actor, CURRENT_TIMESTAMP(), TRUE)
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("l", "STRING", list_name), bigquery.ScalarQueryParameter("email", "STRING", email),
            bigquery.ScalarQueryParameter("label", "STRING", label), bigquery.ScalarQueryParameter("actor", "STRING", actor)]),
    ).result()
    return {"list_name": list_name, "email": email, "label": label}


def remove_recipient(list_name: str, email: str) -> dict:
    valid_list(list_name)
    client().query(
        f"DELETE FROM `{_DATASET}.alert_recipients` WHERE list_name = @l AND email = @email",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("l", "STRING", list_name), bigquery.ScalarQueryParameter("email", "STRING", email)]),
    ).result()
    return {"list_name": list_name, "email": email, "removed": True}


def send_test(list_name: str, actor: str | None) -> dict:
    """One-line Postmark message to the list so DKIM and membership can be checked without a finding."""
    from .emailer import _server_token

    valid_list(list_name)
    to = [r["email"] for r in list_recipients()["lists"].get(list_name, [])]
    if not to:
        raise ValueError(f"{list_name} has no recipients")
    r = requests.post(
        _POSTMARK,
        json={"From": PLATFORM_FROM, "To": ", ".join(to), "Subject": f"[spend] Test message for {list_name}",
              "TextBody": f"Sent from the portal Admin page by {actor or 'unknown'}. If you can read this, the {list_name} list works.",
              "MessageStream": "outbound", "Tag": "spend-monitor-test"},
        headers={"X-Postmark-Server-Token": _server_token(), "Accept": "application/json"}, timeout=15,
    )
    if r.status_code != 200:
        raise ValueError(f"Postmark HTTP {r.status_code}: {r.text[:200]}")
    client().query(
        f"INSERT INTO `{_DATASET}.alert_log` (sent_at, list_name, kind, finding_ids, recipients, subject, postmark_message_id, status) "
        f"VALUES (CURRENT_TIMESTAMP(), @l, 'test', [], @to, @subject, @mid, 'sent')",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("l", "STRING", list_name), bigquery.ArrayQueryParameter("to", "STRING", to),
            bigquery.ScalarQueryParameter("subject", "STRING", f"[spend] Test message for {list_name}"),
            bigquery.ScalarQueryParameter("mid", "STRING", r.json().get("MessageID"))]),
    ).result()
    return {"list_name": list_name, "sent_to": to}


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
