"""Fan Ledger browse endpoints: the warehouse activity ledger as a standalone,
filterable surface (distinct from the per-fan profile card).

Two layers, mirroring the ledger design:
  events   — customerdata_silver.vw_customer_events_live (the hourly-built
             customer_events stream plus the two real-time arms: CIO webhook
             staging and the TB 5-minute poll — same view the per-fan card
             reads; ts filters still prune the base table's day partitions)
  statuses — customerdata_gold.customer_status_ledger (one row per
             email × status_domain, daily build)

Facet options (activities/sources/domains) are computed inside the same
window so dropdowns always reflect reality.
"""

from concurrent.futures import ThreadPoolExecutor

from google.cloud import bigquery

from .bqstate import client
from .config import GCP_PROJECT
from .customers import _safe_dict

_EVENTS = f"{GCP_PROJECT}.customerdata_silver.vw_customer_events_live"
_LEDGER = f"{GCP_PROJECT}.customerdata_gold.customer_status_ledger"

WINDOWS = {"24h": 1, "7d": 7, "30d": 30, "all": None}


def events_page(
    q: str | None,
    activity: str | None,
    source: str | None,
    window: str = "7d",
    include_echo: bool = False,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    days = WINDOWS.get(window, 7)
    where = ["TRUE"]
    params: list[bigquery.ScalarQueryParameter] = []
    if days is not None:
        where.append(f"ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {int(days)} DAY)")
    if not include_echo:
        where.append("is_system_echo = FALSE")
    window_cond = " AND ".join(where)  # facets reflect window+echo, not the narrower filters

    if q:
        where.append(
            "(STRPOS(LOWER(customer), LOWER(@q)) > 0 OR STRPOS(LOWER(activity), LOWER(@q)) > 0)"
        )
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    if activity:
        where.append("activity = @activity")
        params.append(bigquery.ScalarQueryParameter("activity", "STRING", activity))
    if source:
        where.append("source_system = @source")
        params.append(bigquery.ScalarQueryParameter("source", "STRING", source))
    cond = " AND ".join(where)

    def page():
        return [
            _safe_dict(dict(r))
            for r in client()
            .query(
                f"""
                SELECT event_id, ts, customer, activity, source_system, is_system_echo,
                       revenue_impact, TO_JSON_STRING(feature_json) AS feature_json
                FROM `{_EVENTS}` WHERE {cond}
                ORDER BY ts DESC LIMIT {int(limit)} OFFSET {int(offset)}
                """,
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        ]

    def total():
        return list(
            client()
            .query(
                f"SELECT COUNT(*) AS n FROM `{_EVENTS}` WHERE {cond}",
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        )[0].n

    def facets():
        row = list(
            client()
            .query(
                f"""
                SELECT ARRAY_AGG(DISTINCT activity IGNORE NULLS ORDER BY activity) AS activities,
                       ARRAY_AGG(DISTINCT source_system IGNORE NULLS ORDER BY source_system) AS sources
                FROM `{_EVENTS}` WHERE {window_cond}
                """
            )
            .result()
        )[0]
        return {"activities": list(row.activities or []), "sources": list(row.sources or [])}

    with ThreadPoolExecutor(max_workers=3) as ex:
        f_page, f_total, f_facets = ex.submit(page), ex.submit(total), ex.submit(facets)
        rows, n, fac = f_page.result(), f_total.result(), f_facets.result()

    return {"events": rows, "total": n, "limit": limit, "offset": offset, **fac}


def statuses_page(
    q: str | None,
    domain: str | None,
    status: str | None,
    latched_only: bool = False,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    where = ["TRUE"]
    params: list[bigquery.ScalarQueryParameter] = []
    if q:
        where.append("STRPOS(LOWER(email), LOWER(@q)) > 0")
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    if domain:
        where.append("status_domain = @domain")
        params.append(bigquery.ScalarQueryParameter("domain", "STRING", domain))
    if status:
        where.append("status = @status")
        params.append(bigquery.ScalarQueryParameter("status", "STRING", status))
    if latched_only:
        where.append("latched = TRUE")
    cond = " AND ".join(where)

    def page():
        return [
            _safe_dict(dict(r))
            for r in client()
            .query(
                f"""
                SELECT email, status_domain, status, status_since, latched, authority,
                       last_event_at, updated_at
                FROM `{_LEDGER}` WHERE {cond}
                ORDER BY updated_at DESC LIMIT {int(limit)} OFFSET {int(offset)}
                """,
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        ]

    def total():
        return list(
            client()
            .query(
                f"SELECT COUNT(*) AS n FROM `{_LEDGER}` WHERE {cond}",
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        )[0].n

    def facets():
        row = list(
            client()
            .query(
                f"""
                SELECT ARRAY_AGG(DISTINCT status_domain IGNORE NULLS ORDER BY status_domain) AS domains,
                       ARRAY_AGG(DISTINCT status IGNORE NULLS ORDER BY status) AS status_values
                FROM `{_LEDGER}`
                """
            )
            .result()
        )[0]
        # NB: key must not collide with the "statuses" rows list in the merge below.
        return {"domains": list(row.domains or []), "status_values": list(row.status_values or [])}

    with ThreadPoolExecutor(max_workers=3) as ex:
        f_page, f_total, f_facets = ex.submit(page), ex.submit(total), ex.submit(facets)
        rows, n, fac = f_page.result(), f_total.result(), f_facets.result()

    return {"statuses": rows, "total": n, "limit": limit, "offset": offset, **fac}
