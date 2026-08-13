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
_HISTORY_TF = f"{GCP_PROJECT}.customerio_state.tf_campaign_would_fire_history"
_REGISTRY = f"{GCP_PROJECT}.customerio_state.slug_registry"
_KILL_TABLE = f"{GCP_PROJECT}.customerio_state.trigger_kill_switch"

# The kill-switch row that stops EVERY trigger, not one.
KILL_ALL_KEY = "all"

# Triggers with a branch in the history table function. Extend together with
# tf_campaign_would_fire_history.sql — a trigger absent here gets the live
# view only, and the tab says history isn't built for it yet.
HISTORY_TRIGGERS = {
    "stm_welcome_tickets_supporters_260807",
    "stm_welcome_tickets_premium_260807",
}

# Mirror of each trigger's max_per_run circuit breaker in the hub
# (sdfc-platform cio_trigger_hub/triggers.py). A would-fire count above the
# cap means the hub would SKIP the run and alert instead of sending — the
# preview surfaces that so nobody arms a trigger into a breaker trip.
# DRIFT WARNING: update together with triggers.py.
TRIGGER_CAPS = {
    "tb_signup_260715": 2000,
    "welcome_tickets_single_game": 500,
    "welcome_shopify_260715": 200,
    "stm_welcome_tickets_260807": 25,
    "stm_welcome_tickets_supporters_260807": 25,
    "stm_welcome_tickets_premium_260807": 25,
}

# Bullet-list mirror of each trigger's selection SQL in triggers.py (same
# drift warning — update together). Shown on the Triggers tab so a reader
# can tell WHO a trigger selects without opening the hub repo: one predicate
# or fact per bullet, real field names and values.
TRIGGER_LOGIC = {
    "tb_signup_260715": [
        "Source: TradableBits bronze activities (last 3 day-partitions), deduped per activity_id",
        "Join: silver tb_fans for email / name / postal_code (fan not yet synced → row drops, self-heals next run)",
        "activity_ts ≥ now − 72 hours",
        "campaign_title IS NOT NULL (titled forms only)",
        "email present, not '' / 'none' / 'null'",
        "Grain: one event per activity_id — CIO's event filters own the entry policy",
    ],
    "welcome_tickets_single_game": [
        "Source: fan-attributes view, one row per email",
        "ticket_seats_purchased > 0",
        "matches_attended_lifetime = 0",
        "has_season_plan = FALSE",
        "Baseline diff: every historical purchaser was absorbed at bootstrap — a new row means the first purchase just landed",
        "Grain: one fire per email",
    ],
    "welcome_shopify_260715": [
        "WHERE FALSE — selects nothing",
        "Awaiting client entry criteria (likely: first merch order, no ticket history)",
    ],
    "stm_welcome_tickets_supporters_260807": [
        "Source: Salesforce opportunity, joined to account (owner rep) and contact (email fallback)",
        "is_closed = TRUE AND is_won = TRUE",
        "close_date ≥ CURRENT_DATE − 1 day (tightest 24h window on a DATE column)",
        "UPPER(name) LIKE '%SUPP%'",
        "record_type_id = Ticket Sales (012UR000001cuNBYAY)",
        "group_c = 'General Season Tickets'",
        "No-email rows held, not fired, until an email lands in SF or the window ages out",
        "Grain: one fire per opportunity_id",
    ],
    "stm_welcome_tickets_premium_260807": [
        "Source: Salesforce opportunity, joined to account (owner rep) and contact (email fallback)",
        "is_closed = TRUE AND is_won = TRUE",
        "close_date ≥ CURRENT_DATE − 1 day (tightest 24h window on a DATE column)",
        "record_type_id = Premium Sales (012UR000001fAEAYA2)",
        "koreps2_product_c = 'Premium Season Membership' — the spec's 'Premium Membership' group has no Salesforce analog (approved mapping)",
        "No deal-name marker: Premium Sales names are auto-generated, a marker adds nothing",
        "No-email rows held, not fired, until an email lands in SF or the window ages out",
        "Grain: one fire per opportunity_id",
    ],
    "stm_welcome_tickets_260807": [
        "WHERE FALSE — shadow placeholder, selects nothing",
        "General STM closed/won still lives on the legacy cio_welcome_trigger poller (CIO pair #37/#38, unscheduled since Jul 6)",
        "Reserved until the client re-spec; cutover ports the poller SQL (opportunity grain)",
    ],
}

# The webhook payload each trigger POSTs — field per line, mirrored from the
# SELECT list in triggers.py (same drift warning).
_SF_MEMBERSHIP_PAYLOAD = [
    "dedup_key — the opportunity id (exactly-once key)",
    "email — Person Account person_email, else Contact email",
    "first_name / last_name / account_name",
    "account_id — SF 18-char id; the CIO Create/Update Person identifier the People sync converges on",
    "opportunity_id / opportunity_name / stage_name",
    "is_closed / is_won",
    "product / amount / seat_block / number_of_seats / ticket_price",
    "close_date — DATE as string",
    "rep_name / rep_email / rep_phone / account_owner — the SF Account Owner's User record (not the legacy digideck fields)",
    "ticketing_event_date — next real home match as unix epoch (feeds CIO's Wait Until); null in the off-season",
    "ticketing_event_name",
]
TRIGGER_PAYLOAD = {
    "tb_signup_260715": [
        "dedup_key — the activity_id (exactly-once key)",
        "email — from the fan profile",
        "activity_id / campaign_title",
        "signup_form_family — world_cup · stay_informed · etw · other",
        "is_world_cup / is_new_fan_24h — fan created within 24h of the activity",
        "fan_created_at / activity_at — ISO timestamps",
        "first_name / last_name / postal_code",
        "fan_source / phone_subscribed / has_season_plan",
    ],
    "welcome_tickets_single_game": [
        "dedup_key — the email (exactly-once key)",
        "email / first_name / last_name",
        "tm_acct_id — Ticketmaster account id",
        "ticket_seats_purchased / events_ticketed",
    ],
    "welcome_shopify_260715": [
        "dedup_key — the email (exactly-once key)",
        "email / first_name / last_name",
        "shopify_amount_spent",
    ],
    "stm_welcome_tickets_supporters_260807": _SF_MEMBERSHIP_PAYLOAD,
    "stm_welcome_tickets_premium_260807": _SF_MEMBERSHIP_PAYLOAD,
    "stm_welcome_tickets_260807": [
        "dedup_key — the sf_account_id",
        "email / first_name / last_name",
        "stm_product / stm_amount / close_date",
        "Drafted only — WHERE FALSE means nothing ever POSTs",
    ],
}

# Mirror of each trigger's `enabled` flag in triggers.py (same drift
# warning). False = the preview view carries drafted/placeholder logic the
# hub won't execute yet — the tab labels these "not enabled", so the list
# reads as a demonstration of the selection logic, not a pending send.
TRIGGER_ENABLED = {
    "tb_signup_260715": False,  # switched off 2026-08-11 — hold until launch decision
    "welcome_tickets_single_game": False,  # switched off 2026-08-11; re-baseline before re-enabling
    "welcome_shopify_260715": False,  # draft SQL in the view; WHERE FALSE in the hub
    "stm_welcome_tickets_260807": True,  # enabled 2026-08-13 (Dean); query still WHERE FALSE until the re-spec lands
    "stm_welcome_tickets_supporters_260807": True,  # SUPP deals — CIO relay pair 60/61
    "stm_welcome_tickets_premium_260807": True,  # Premium Season Membership — CIO relay pair 68/69
}


def triggers_overview() -> dict:
    """Every warehouse trigger the portal knows about, joined three ways.

    A row per trigger key in the union of the hub mirrors (TRIGGER_CAPS /
    TRIGGER_ENABLED) and the registry's trigger_key column, so both failure
    modes are visible: a registry key the hub has never heard of (fires
    nothing, ever) and a hub trigger no campaign is registered to (fires
    into a webhook nobody is validating). Candidate counts come live from
    the would-fire view; fire stats from the hub's fire log. Read-only.
    """

    def registry():
        return [
            dict(r)
            for r in client()
            .query(
                f"""
                SELECT slug, display_name, trigger_key, trigger_label
                FROM `{_REGISTRY}` WHERE trigger_key IS NOT NULL
                """
            )
            .result()
        ]

    def candidates():
        return {
            r.trigger: r.n
            for r in client()
            .query(f"SELECT trigger, COUNT(*) AS n FROM `{_PREVIEW_VIEW}` GROUP BY trigger")
            .result()
        }

    def fires():
        return {
            r.trigger: r
            for r in client()
            .query(
                f"""
                SELECT trigger, COUNT(*) AS total,
                       COUNTIF(status = 'sent') AS sent,
                       COUNTIF(status = 'failed') AS failed,
                       MAX(fired_at) AS last_fired_at
                FROM `{_VIEW}` GROUP BY trigger
                """
            )
            .result()
        }

    def kills():
        return {
            r.trigger_key: r
            for r in client()
            .query(
                f"""
                SELECT trigger_key, killed, reason, updated_by, updated_at
                FROM `{_KILL_TABLE}` WHERE killed
                """
            )
            .result()
        }

    with ThreadPoolExecutor(max_workers=4) as ex:
        f_reg, f_cand, f_fires, f_kills = (
            ex.submit(registry),
            ex.submit(candidates),
            ex.submit(fires),
            ex.submit(kills),
        )
        reg, cand, fire, kill = f_reg.result(), f_cand.result(), f_fires.result(), f_kills.result()

    def kill_info(row):
        return {
            "reason": row.reason,
            "by": row.updated_by,
            "at": row.updated_at.isoformat() if row.updated_at else None,
        }

    by_key: dict[str, list[dict]] = {}
    for r in reg:
        by_key.setdefault(r["trigger_key"], []).append(r)

    keys = sorted(set(TRIGGER_CAPS) | set(TRIGGER_ENABLED) | set(by_key))
    rows = []
    for key in keys:
        entries = by_key.get(key, [])
        f = fire.get(key)
        k = kill.get(key)
        rows.append(
            {
                "key": key,
                "killed": k is not None,
                "kill": kill_info(k) if k is not None else None,
                "label": next((e["trigger_label"] for e in entries if e["trigger_label"]), None),
                "in_hub": key in TRIGGER_CAPS or key in TRIGGER_ENABLED,
                "enabled": TRIGGER_ENABLED.get(key),
                "cap": TRIGGER_CAPS.get(key),
                "logic": TRIGGER_LOGIC.get(key),
                "payload": TRIGGER_PAYLOAD.get(key),
                "has_history": key in HISTORY_TRIGGERS,
                "campaigns": [
                    {"slug": e["slug"], "display_name": e["display_name"]} for e in entries
                ],
                "candidates": cand.get(key, 0),
                "fires_total": f.total if f else 0,
                "fires_sent": f.sent if f else 0,
                "fires_failed": f.failed if f else 0,
                # absorbed = written to the log without a send attempt:
                # suppressions, bootstrap baselines, poller-cutover history
                "fires_absorbed": (f.total - f.sent - f.failed) if f else 0,
                "last_fired_at": f.last_fired_at.isoformat() if f and f.last_fired_at else None,
            }
        )
    hub_kill = kill.get(KILL_ALL_KEY)
    return {
        "triggers": rows,
        "hub_killed": kill_info(hub_kill) if hub_kill is not None else None,
    }


def set_trigger_kill(trigger_key: str, killed: bool, reason: str | None, actor: str) -> None:
    """Flip the emergency kill switch for one trigger (or 'all').

    OFF-ONLY by design on the hub side: the hub consults this table as
    "AND NOT killed", so writing killed=TRUE stops sends but killed=FALSE
    can never enable a trigger the code has disabled. MERGE keeps one row
    per key; updated_by/updated_at are the audit trail.
    """
    client().query(
        f"""
        MERGE `{_KILL_TABLE}` t
        USING (SELECT @key AS trigger_key) s
        ON t.trigger_key = s.trigger_key
        WHEN MATCHED THEN UPDATE SET
          killed = @killed, reason = @reason,
          updated_by = @actor, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (trigger_key, killed, reason, updated_by, updated_at)
        VALUES (@key, @killed, @reason, @actor, CURRENT_TIMESTAMP())
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("key", "STRING", trigger_key),
                bigquery.ScalarQueryParameter("killed", "BOOL", killed),
                bigquery.ScalarQueryParameter("reason", "STRING", reason or None),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
            ]
        ),
    ).result()


def set_trigger_label(trigger_key: str, label: str | None, actor: str) -> int:
    """Rename a trigger's display label — cosmetic only, the key stays the id.

    The label lives on the slug_registry row(s) carrying this trigger_key
    (there is no standalone trigger table yet), so a trigger with no
    registered campaign has nowhere to store one — callers 404 on 0 rows.
    Empty/None clears the label and the UI falls back to the key.
    """
    job = client().query(
        f"""
        UPDATE `{_REGISTRY}`
        SET trigger_label = @label,
            updated_at = CURRENT_TIMESTAMP(), updated_by = @actor
        WHERE trigger_key = @key
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("label", "STRING", label or None),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
                bigquery.ScalarQueryParameter("key", "STRING", trigger_key),
            ]
        ),
    )
    job.result()
    return job.num_dml_affected_rows or 0


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
    days: int | None = None,
) -> dict | None:
    """One page of would-fire rows for the slug's trigger.

    days=None reads vw_campaign_would_fire — the hub's own deduped candidate
    SQL as a view — so this is exactly the set (and payloads) the next hourly
    run would POST. days=N reads the history table function instead: every
    event the trigger would have fired on in the trailing N days (no fire-log
    dedup — already-fired events are the point of a history view). Both are
    strictly display; nothing here can send a webhook. Live query against
    the warehouse. Same None / empty-page contract as affected_page; `cap`
    is the trigger's circuit breaker for the over-cap warning in the UI.
    """
    entry = get_slug(slug)
    if entry is None:
        return None
    trigger_key = entry.get("trigger_key")
    cap = TRIGGER_CAPS.get(trigger_key)
    enabled = TRIGGER_ENABLED.get(trigger_key)
    history_available = trigger_key in HISTORY_TRIGGERS
    empty = {"trigger_key": trigger_key,
             "trigger_label": entry.get("trigger_label"),
             "rows": [], "total": 0,
             "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
             "days": days, "history_available": history_available}
    if not trigger_key or (days and not history_available):
        return empty

    rows, n = _preview_rows(trigger_key, q, limit, offset, days)
    return {"trigger_key": trigger_key,
            "trigger_label": entry.get("trigger_label"),
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
            "days": days, "history_available": history_available}


def _preview_rows(
    trigger_key: str,
    q: str | None,
    limit: int,
    offset: int,
    days: int | None,
) -> tuple[list[dict], int]:
    """(rows, total) from the would-fire view (days=None) or history TVF."""
    source = f"`{_PREVIEW_VIEW}`" if not days else f"`{_HISTORY_TF}`({int(days)})"

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
                FROM {source} WHERE {cond}
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
                f"SELECT COUNT(*) AS n FROM {source} WHERE {cond}",
                job_config=bigquery.QueryJobConfig(query_parameters=params),
            )
            .result()
        )[0].n

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_page, f_total = ex.submit(page), ex.submit(total)
        return f_page.result(), f_total.result()


def trigger_preview_page(
    trigger_key: str,
    q: str | None,
    limit: int = 20,
    offset: int = 0,
    days: int | None = None,
) -> dict:
    """Same preview as would_fire_page, addressed by trigger key directly.

    The Triggers tab asks per trigger, not per campaign — a trigger with no
    registered campaign is still previewable. days=None = the live next-run
    selection; days=N = every event of the trailing N days from the history
    TVF. Strictly display; nothing here can send a webhook.
    """
    cap = TRIGGER_CAPS.get(trigger_key)
    enabled = TRIGGER_ENABLED.get(trigger_key)
    history_available = trigger_key in HISTORY_TRIGGERS
    if days and not history_available:
        rows, n = [], 0
    else:
        rows, n = _preview_rows(trigger_key, q, limit, offset, days)
    return {"trigger_key": trigger_key,
            "trigger_label": None,
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
            "days": days, "history_available": history_available}
