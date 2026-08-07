"""Affected customers: who a campaign's warehouse trigger actually selected.

Reads customerio_state.vw_campaign_affected_customers — one row per
cio-trigger-hub fire attempt (any trigger), with the exact payload JSON the
campaign's inbound webhook received. The view's `trigger` column joins to
slug_registry.trigger_key, so the drilldown asks by slug and we resolve the
key here; a slug with no trigger key gets an empty page (the tab renders the
"register a trigger key" hint), not an error.

Status vocabulary (from the hub's state table): sent = webhook accepted
(200/202) · failed = post error, retried next hourly run · suppressed /
baseline = absorbed without firing (bootstraps, marketing decisions, poller
cutover history). The client-facing loop: watch a payload land on the
campaign's inbound webhook in CIO, then confirm the same person/payload here.

ACL: portal SA reads customerio_state (same grant the slug registry uses).
"""

from concurrent.futures import ThreadPoolExecutor

from google.cloud import bigquery

from .bqstate import client
from .config import GCP_PROJECT
from .customers import _safe_dict
from .slugs import get_slug

_VIEW = f"{GCP_PROJECT}.customerio_state.vw_campaign_affected_customers"
_PREVIEW_VIEW = f"{GCP_PROJECT}.customerio_state.vw_campaign_would_fire"

# Mirror of each trigger's max_per_run circuit breaker in the hub
# (sdfc-platform cio_trigger_hub/triggers.py). A would-fire count above the
# cap means the hub would SKIP the run and alert instead of sending — the
# preview surfaces that so nobody arms a trigger into a breaker trip.
# DRIFT WARNING: update together with triggers.py.
TRIGGER_CAPS = {
    "tb_signup": 2000,
    "welcome_tickets_single_game": 500,
    "welcome_shopify": 200,
    "welcome_tickets_membership": 25,
    "welcome_tickets_supporters": 25,
}

# Mirror of each trigger's `enabled` flag in triggers.py (same drift
# warning). False = the preview view carries drafted/placeholder logic the
# hub won't execute yet — the tab labels these "not enabled", so the list
# reads as a demonstration of the selection logic, not a pending send.
TRIGGER_ENABLED = {
    "tb_signup": True,
    "welcome_tickets_single_game": True,
    "welcome_shopify": False,  # draft SQL in the view; WHERE FALSE in the hub
    "welcome_tickets_membership": False,  # reserved for the general STM journey re-spec
    "welcome_tickets_supporters": True,  # SUPP deals — CIO relay pair 60/61
}


def affected_page(
    slug: str,
    q: str | None,
    status: str | None,
    limit: int = 20,
    offset: int = 0,
) -> dict | None:
    """One page of fire-log rows for the slug's trigger, newest first.

    Returns None when the slug isn't registered at all (route 404s);
    an empty page with trigger_key=None when registered but unmapped.
    """
    entry = get_slug(slug)
    if entry is None:
        return None
    trigger_key = entry.get("trigger_key")
    empty = {"trigger_key": trigger_key,
             "trigger_label": entry.get("trigger_label"),
             "rows": [], "total": 0,
             "limit": limit, "offset": offset, "statuses": []}
    if not trigger_key:
        return empty

    where = ["trigger = @trigger"]
    params = [bigquery.ScalarQueryParameter("trigger", "STRING", trigger_key)]
    trigger_cond = where[0]  # status facet reflects the whole trigger, not the narrower filters
    if q:
        where.append(
            "(STRPOS(LOWER(COALESCE(email, '')), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(COALESCE(first_name, '')), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(COALESCE(last_name, '')), LOWER(@q)) > 0)"
        )
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    if status:
        where.append("status = @status")
        params.append(bigquery.ScalarQueryParameter("status", "STRING", status))
    cond = " AND ".join(where)

    def page():
        return [
            _safe_dict(dict(r))
            for r in client()
            .query(
                f"""
                SELECT email, first_name, last_name, status, status_code, error,
                       fired_at, dedup_key, payload_json
                FROM `{_VIEW}` WHERE {cond}
                ORDER BY fired_at DESC LIMIT {int(limit)} OFFSET {int(offset)}
                """,
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        ]

    def total():
        return list(
            client()
            .query(
                f"SELECT COUNT(*) AS n FROM `{_VIEW}` WHERE {cond}",
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        )[0].n

    def facets():
        row = list(
            client()
            .query(
                f"""
                SELECT ARRAY_AGG(DISTINCT status IGNORE NULLS ORDER BY status) AS statuses
                FROM `{_VIEW}` WHERE {trigger_cond}
                """,
                job_config=bigquery.QueryJobConfig(query_parameters=[params[0]]),
            )
            .result()
        )[0]
        return list(row.statuses or [])

    with ThreadPoolExecutor(max_workers=3) as ex:
        f_page, f_total, f_facets = ex.submit(page), ex.submit(total), ex.submit(facets)
        rows, n, statuses = f_page.result(), f_total.result(), f_facets.result()

    return {"trigger_key": trigger_key,
            "trigger_label": entry.get("trigger_label"),
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "statuses": statuses}


def would_fire_page(
    slug: str,
    q: str | None,
    limit: int = 20,
    offset: int = 0,
) -> dict | None:
    """One page of would-fire-next-run rows for the slug's trigger.

    Reads vw_campaign_would_fire — the hub's own deduped candidate SQL as a
    view — so this is exactly the set (and payloads) the next hourly run
    would POST. Live query against the warehouse: freshness is the sources',
    not the hub's schedule. Same None / empty-page contract as
    affected_page; `cap` is the trigger's circuit breaker for the over-cap
    warning in the UI.
    """
    entry = get_slug(slug)
    if entry is None:
        return None
    trigger_key = entry.get("trigger_key")
    cap = TRIGGER_CAPS.get(trigger_key)
    enabled = TRIGGER_ENABLED.get(trigger_key)
    empty = {"trigger_key": trigger_key,
             "trigger_label": entry.get("trigger_label"),
             "rows": [], "total": 0,
             "limit": limit, "offset": offset, "cap": cap, "enabled": enabled}
    if not trigger_key:
        return empty

    where = ["trigger = @trigger"]
    params = [bigquery.ScalarQueryParameter("trigger", "STRING", trigger_key)]
    if q:
        where.append(
            "(STRPOS(LOWER(COALESCE(email, '')), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(COALESCE(first_name, '')), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(COALESCE(last_name, '')), LOWER(@q)) > 0)"
        )
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    cond = " AND ".join(where)

    def page():
        return [
            _safe_dict(dict(r))
            for r in client()
            .query(
                f"""
                SELECT email, first_name, last_name, event_at, dedup_key,
                       payload_json
                FROM `{_PREVIEW_VIEW}` WHERE {cond}
                ORDER BY event_at DESC NULLS LAST, dedup_key
                LIMIT {int(limit)} OFFSET {int(offset)}
                """,
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        ]

    def total():
        return list(
            client()
            .query(
                f"SELECT COUNT(*) AS n FROM `{_PREVIEW_VIEW}` WHERE {cond}",
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        )[0].n

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_page, f_total = ex.submit(page), ex.submit(total)
        rows, n = f_page.result(), f_total.result()

    return {"trigger_key": trigger_key,
            "trigger_label": entry.get("trigger_label"),
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "cap": cap, "enabled": enabled}
