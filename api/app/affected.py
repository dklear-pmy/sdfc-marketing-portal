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

import json
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

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
_SETTINGS_TABLE = f"{GCP_PROJECT}.customerio_state.trigger_settings"
_HUB_RUNS_TABLE = f"{GCP_PROJECT}.customerio_state.hub_runs"

# Upper bound on waiting for a preview query's RESULT. The queries themselves
# finish in 1-4s (3,280 portal jobs over 2026-08-21..24: max run 4.3s, max
# queue 0.5s); the one 36s preview seen in that window stalled in the
# container AFTER its BigQuery job had finished. Without a bound, that stall
# is an open-ended skeleton in the portal. With it, the request fails fast
# as a 504 and the frontend's retry gets a fresh attempt.
_BQ_RESULT_TIMEOUT_S = 25


class PreviewTimeout(TimeoutError):
    """A preview query did not return within _BQ_RESULT_TIMEOUT_S."""


# The kill-switch row that stops EVERY trigger, not one.
KILL_ALL_KEY = "all"

# Triggers with a branch in the history table function. Extend together with
# tf_campaign_would_fire_history.sql — a trigger absent here gets the live
# view only, and the tab explains why using NO_HISTORY_REASON below.
#
# The dividing line is whether the trigger selects on a TIMESTAMPED EVENT:
# an event carries its own time, so "what would have fired N days ago" is
# reconstructable. A trigger that selects on current fan STATE cannot be
# replayed — the warehouse keeps no snapshot of what that state used to be.
HISTORY_TRIGGERS = {
    "tb_signup_260715",
    "welcome_shopify_260715",
    "stm_welcome_tickets_supporters_260807",
    "stm_welcome_tickets_premium_260813",
    "stm_welcome_tickets_260807",
}

# Why a trigger has no history, in the reader's terms. Absent key => the
# generic "not built yet" line; a trigger here is one where history is not
# merely unbuilt but not reconstructable from what the warehouse retains.
NO_HISTORY_REASON = {
    "welcome_tickets_single_game": (
        "This trigger selects on a fan's CURRENT state — first ticket purchase, "
        "no attendance, no season plan — rather than on a timestamped event. The "
        "warehouse keeps no snapshot of what that state was on a past day, so "
        "there is no honest way to reconstruct who it would have caught. Only the "
        "live next-run view is available."
    ),
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
    "stm_welcome_tickets_260807": 100,
    "stm_welcome_tickets_supporters_260807": 25,
    "stm_welcome_tickets_premium_260813": 25,
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
        "Source: shopify_silver.orders, one row per email on the FIRST kept order across the store's whole history",
        "financial_status NOT IN ('REFUNDED', 'VOIDED') — a refunded first order lets the next paid one count; partial refunds count",
        "first order created_at ≥ now − 72 hours",
        "No ticket history, read from the fan-attributes view: ticket_seats_purchased = 0, has_season_plan = FALSE, matches_attended_lifetime = 0 (missing row passes)",
        "Staff excluded: @sandiegofc.com / @pmygroup.com buyers at the stadium store",
        "Names COALESCE to '' — shopify_silver hashes every name column and the view is blank for ~36% of buyers; CIO rejects a NULL trigger variable",
        "Grain: one fire per email — the person's first purchase, exactly once",
    ],
    "stm_welcome_tickets_supporters_260807": [
        "Source: Salesforce opportunity, joined to account (owner rep) and contact (email fallback)",
        "is_closed = TRUE AND is_won = TRUE",
        "close_date ≥ CURRENT_DATE − 1 day (tightest 24h window on a DATE column)",
        "UPPER(name) LIKE '%SUPP%'",
        "record_type_id = Ticket Sales (012UR000001cuNBYAY)",
        "group_c = 'General Season Tickets'",
        "Excludes initial-payment deposits and group sales — the welcome belongs to the deal that completes the purchase",
        "No-email rows held, not fired, until an email lands in SF or the window ages out",
        "Grain: one fire per opportunity_id",
    ],
    "stm_welcome_tickets_premium_260813": [
        "Source: Salesforce opportunity, joined to account (owner rep) and contact (email fallback)",
        "is_closed = TRUE AND is_won = TRUE",
        "close_date ≥ CURRENT_DATE − 1 day (tightest 24h window on a DATE column)",
        "record_type_id = Premium Sales (012UR000001fAEAYA2)",
        "koreps2_product_c = 'Premium Season Membership' — the spec's 'Premium Membership' group has no Salesforce analog (approved mapping)",
        "No deal-name marker: Premium Sales names are auto-generated, a marker adds nothing",
        "Excludes initial-payment deposits and group sales — the welcome belongs to the deal that completes the purchase",
        "No-email rows held, not fired, until an email lands in SF or the window ages out",
        "Grain: one fire per opportunity_id",
    ],
    "stm_welcome_tickets_260807": [
        "Source: Salesforce opportunity, joined to account (owner rep) and contact (email fallback)",
        "is_closed = TRUE AND is_won = TRUE",
        "close_date ≥ CURRENT_DATE − 1 day (tightest 24h window on a DATE column)",
        "record_type_id = Ticket Sales (012UR000001cuNBYAY)",
        "koreps2_product_c = 'General Season Membership'",
        "group_c = 'General Season Tickets'",
        "UPPER(name) NOT LIKE '%SUPP%' — the COMPLEMENT of the supporters trigger, so the two split that family and never both fire",
        "Excludes initial-payment deposits and group sales — the welcome belongs to the deal that completes the purchase",
        "No-email rows held, not fired, until an email lands in SF or the window ages out",
        "Grain: one fire per opportunity_id",
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
    "opportunity_owner_name / opportunity_owner_email / opportunity_owner_phone — the Opportunity Owner's User record (the deal closer; a different person from rep_* on most closed-won deals)",
    "ticketing_event_date — next real home match as unix epoch (feeds CIO's Wait Until); null in the off-season",
    "ticketing_event_name",
]
TRIGGER_PAYLOAD = {
    "tb_signup_260715": [
        "dedup_key — the lowercased email (exactly-once key: one welcome per PERSON, not per form entry — since 2026-08-27)",
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
        "email / first_name / last_name ('' when the warehouse has no name)",
        "order_id / order_number — the first kept Shopify order",
        "order_total — what the fan paid on that order (after discounts, incl. tax and shipping, USD); on the event for segmentation, not a template variable",
        "first_order_at — ISO-8601 UTC",
        "is_new_to_warehouse — TRUE when Shopify is the only system that knows this person (no Ticketmaster account, no TradableBits fan record)",
    ],
    "stm_welcome_tickets_supporters_260807": _SF_MEMBERSHIP_PAYLOAD,
    "stm_welcome_tickets_premium_260813": _SF_MEMBERSHIP_PAYLOAD,
    "stm_welcome_tickets_260807": _SF_MEMBERSHIP_PAYLOAD,
}

# Mirror of each trigger's CODE GATE in the hub (Trigger.enabled in
# triggers.py) — structural only: False means the hub never evaluates it
# (placeholder queries) and the portal cannot enable it. Whether a code-open
# trigger actually SENDS is the Enabled toggle in
# customerio_state.trigger_settings, read live — nothing to mirror there.
# DRIFT WARNING: update together with triggers.py.
TRIGGER_CODE_ENABLED = {
    "tb_signup_260715": True,  # code gate opened 2026-08-24 — Welcome-General-260715; CIO PROD pair 45/41
    "welcome_tickets_single_game": True,  # code gate opened 2026-08-24 — backlog since the Jul-16 baseline must be re-baselined or fired deliberately BEFORE enabling
    "welcome_shopify_260715": True,  # code gate opened 2026-09-03 — first Shopify order, no ticket history; CIO PROD pair 46/44 still draft — held by its state row
    "stm_welcome_tickets_260807": True,  # complement of the two carve-outs (re-specced 2026-08-18); CIO relay pair 72/65
    "stm_welcome_tickets_supporters_260807": True,  # SUPP deals — CIO relay pair 74/67
    "stm_welcome_tickets_premium_260813": True,  # CIO relay pair 75/71 still draft — held by its Enabled toggle, not by code
}


def triggers_overview() -> dict:
    """Every warehouse trigger the portal knows about, joined three ways.

    A row per trigger key in the union of the hub mirrors (TRIGGER_CAPS /
    TRIGGER_CODE_ENABLED) and the registry's trigger_key column, so both failure
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

    def settings():
        return {
            r.trigger_key: r
            for r in client()
            .query(
                f"""
                SELECT trigger_key, state, reason, updated_by, updated_at
                FROM `{_SETTINGS_TABLE}`
                """
            )
            .result()
        }

    def last_run():
        rows = list(
            client()
            .query(
                f"""
                SELECT run_at, target, global_dry_run, ok,
                       TO_JSON_STRING(triggers) AS triggers
                FROM `{_HUB_RUNS_TABLE}`
                WHERE run_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
                ORDER BY run_at DESC LIMIT 1
                """
            )
            .result()
        )
        return rows[0] if rows else None

    with ThreadPoolExecutor(max_workers=6) as ex:
        f_reg, f_cand, f_fires, f_kills, f_set, f_run = (
            ex.submit(registry),
            ex.submit(candidates),
            ex.submit(fires),
            ex.submit(kills),
            ex.submit(settings),
            ex.submit(last_run),
        )
        reg, cand, fire, kill = f_reg.result(), f_cand.result(), f_fires.result(), f_kills.result()
        setting, run = f_set.result(), f_run.result()
    run_triggers = json.loads(run.triggers) if run and run.triggers else {}

    def kill_info(row):
        return {
            "reason": row.reason,
            "by": row.updated_by,
            "at": row.updated_at.isoformat() if row.updated_at else None,
        }

    by_key: dict[str, list[dict]] = {}
    for r in reg:
        by_key.setdefault(r["trigger_key"], []).append(r)

    keys = sorted(set(TRIGGER_CAPS) | set(TRIGGER_CODE_ENABLED) | set(by_key))
    rows = []
    for key in keys:
        entries = by_key.get(key, [])
        f = fire.get(key)
        k = kill.get(key)
        st = setting.get(key)
        lr = run_triggers.get(key)
        rows.append(
            {
                "key": key,
                "killed": k is not None,
                "kill": kill_info(k) if k is not None else None,
                "label": next((e["trigger_label"] for e in entries if e["trigger_label"]), None),
                "in_hub": key in TRIGGER_CAPS or key in TRIGGER_CODE_ENABLED,
                # code gate (hub evaluates it at all) vs the portal's state
                # (enabled = it actually sends; disabled = built, off; draft =
                # still being built). No settings row == disabled; a code-
                # closed trigger is always draft whatever its row says.
                "code_enabled": TRIGGER_CODE_ENABLED.get(key),
                "state": effective_state(key, st.state if st is not None else None),
                "enabled": effective_state(key, st.state if st is not None else None) == "enabled",
                "state_info": kill_info(st) if st is not None else None,
                # what the hub's LAST run actually did with this trigger
                "last_run": (
                    {
                        "at": run.run_at.isoformat(),
                        "mode": lr.get("mode"),
                        "candidates": lr.get("candidates", 0),
                        "fired": lr.get("fired", 0),
                        "failed": lr.get("failed", 0),
                        "skipped": lr.get("skipped"),
                    }
                    if run is not None and lr is not None
                    else None
                ),
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
        # The hub-wide DRY_RUN override as of the last run: while True, no
        # trigger sends whatever its toggle says — the UI must say so.
        "hub_dry_run": bool(run.global_dry_run) if run is not None else None,
        "hub_last_run_at": run.run_at.isoformat() if run is not None else None,
        "hub_target": run.target if run is not None else None,
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


TRIGGER_STATES = ("enabled", "disabled", "draft")


def effective_state(trigger_key: str, stored: str | None) -> str:
    """The state the portal shows. A code-closed trigger (placeholder query)
    is draft no matter what its row says — the hub never evaluates it;
    otherwise the stored value, with no row meaning disabled."""
    if not TRIGGER_CODE_ENABLED.get(trigger_key):
        return "draft"
    return stored if stored in TRIGGER_STATES else "disabled"


def state_change_error(
    trigger_key: str, state: str, role: str, absorb: bool = False
) -> tuple[int, str] | None:
    """Why a state change is refused, as (http status, message) — or None
    when it may proceed. Pure, so the gate is testable without BigQuery:
      404  unknown key
      400  unknown state
      400  any change on a code-closed trigger (locked at draft — its query
           is a placeholder the hub never evaluates)
      400  absorb with anything but enabled (absorbing is the prelude to arming)
      403  enabling as a non-admin (it starts real sends to fans)
    Disabling / drafting is operator-level — the safe direction."""
    if trigger_key not in TRIGGER_CODE_ENABLED:
        return 404, "No such trigger in the hub"
    if state not in TRIGGER_STATES:
        return 400, f"state must be one of {', '.join(TRIGGER_STATES)}"
    if not TRIGGER_CODE_ENABLED.get(trigger_key):
        return 400, (
            "This trigger is switched off in the hub's code (placeholder query) — "
            "it stays in draft until the hub carries a real query"
        )
    if absorb and state != "enabled":
        return 400, "Absorbing the backlog only makes sense when enabling — send state=enabled"
    if state == "enabled" and role != "admin":
        return 403, "Enabling starts real sends to fans — admin only"
    return None


def absorb_candidates_as_baseline(trigger_key: str) -> int:
    """Write every CURRENT would-fire candidate of a trigger into the hub's
    state table as status='baseline' — the same operation the Jul-16
    bootstrap used — so those people never receive the email and only
    matches that land from now on fire. Returns the number absorbed.

    INSERT … SELECT from vw_campaign_would_fire, which is the hub's own
    candidate SQL MINUS everyone already in state: it can never duplicate a
    key, and it absorbs whatever is current at execution (not the count the
    dialog showed a moment earlier — that is the right semantics for a
    rolling window like tb_signup's 72h). The payload is kept so the fire
    log shows WHO was absorbed, not just how many."""
    job = client().query(
        f"""
        INSERT INTO `{GCP_PROJECT}.customerio_state.cio_trigger_log`
          (trigger, dedup_key, email, payload, status, status_code, error, fired_at)
        SELECT trigger, dedup_key, email, payload_json, 'baseline', NULL, NULL,
               CURRENT_TIMESTAMP()
        FROM `{_PREVIEW_VIEW}`
        WHERE trigger = @key
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("key", "STRING", trigger_key)]
        ),
    )
    job.result()
    return job.num_dml_affected_rows or 0


def set_trigger_state(trigger_key: str, state: str, reason: str | None, actor: str) -> None:
    """Set a trigger's state — the hub reads this row on its next run.
    'enabled' arms real sends; 'disabled' / 'draft' (or no row) run it dry.
    MERGE keeps one row per key; updated_by/updated_at are the audit trail."""
    client().query(
        f"""
        MERGE `{_SETTINGS_TABLE}` t
        USING (SELECT @key AS trigger_key) s
        ON t.trigger_key = s.trigger_key
        WHEN MATCHED THEN UPDATE SET
          state = @state, reason = @reason,
          updated_by = @actor, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (trigger_key, state, reason, updated_by, updated_at)
        VALUES (@key, @state, @reason, @actor, CURRENT_TIMESTAMP())
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("key", "STRING", trigger_key),
                bigquery.ScalarQueryParameter("state", "STRING", state),
                bigquery.ScalarQueryParameter("reason", "STRING", reason or None),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
            ]
        ),
    ).result()


def trigger_enabled(trigger_key: str) -> bool:
    """Does this trigger SEND — state == 'enabled'. No row == disabled, same
    as the hub."""
    rows = list(
        client()
        .query(
            f"SELECT state FROM `{_SETTINGS_TABLE}` WHERE trigger_key = @key LIMIT 1",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("key", "STRING", trigger_key)]
            ),
        )
        .result()
    )
    return bool(rows) and effective_state(trigger_key, rows[0].state) == "enabled"


def trigger_directory(enabled_only: bool = False) -> list[dict]:
    """Every known trigger as {key, slug, label} — registry campaigns plus
    hub-only keys with no registration yet. Drives the all-campaigns export,
    where each entry becomes a worksheet. enabled_only keeps the triggers the
    hub EVALUATES (code gate open — TRIGGER_CODE_ENABLED), which includes
    ones still in dry-run: the export previews who would be sent, so a
    trigger being reviewed before arming belongs in it. Placeholders and
    not-in-hub keys drop out."""
    by_key: dict[str, dict] = {}
    for r in (
        client()
        .query(
            f"""SELECT trigger_key, slug, trigger_label
                FROM `{_REGISTRY}` WHERE trigger_key IS NOT NULL
                ORDER BY trigger_key, slug"""
        )
        .result()
    ):
        by_key.setdefault(
            r.trigger_key, {"key": r.trigger_key, "slug": r.slug, "label": r.trigger_label}
        )
    for key in TRIGGER_CAPS:
        by_key.setdefault(key, {"key": key, "slug": None, "label": None})
    keys = sorted(by_key)
    if enabled_only:
        keys = [k for k in keys if TRIGGER_CODE_ENABLED.get(k) is True]
    return [by_key[k] for k in keys]


def slug_for_trigger(trigger_key: str) -> str | None:
    """The registered campaign slug carrying this trigger key, if any — the
    name the portal URL and export filenames lead with. First row wins on
    the (theoretical) multi-campaign case, matching the UI's choice."""
    rows = list(
        client()
        .query(
            f"SELECT slug FROM `{_REGISTRY}` WHERE trigger_key = @key ORDER BY slug LIMIT 1",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("key", "STRING", trigger_key)]
            ),
        )
        .result()
    )
    return rows[0].slug if rows else None


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
            .result(timeout=_BQ_RESULT_TIMEOUT_S)
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
    enabled = trigger_enabled(trigger_key)  # the portal toggle — does it SEND
    history_available = trigger_key in HISTORY_TRIGGERS
    reason = None if history_available else NO_HISTORY_REASON.get(trigger_key)
    empty = {"trigger_key": trigger_key,
             "trigger_label": entry.get("trigger_label"),
             "rows": [], "total": 0,
             "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
             "days": days, "history_available": history_available,
             "no_history_reason": reason}
    if not trigger_key or (days and not history_available):
        return empty

    rows, n = _preview_rows(trigger_key, q, limit, offset, days)
    return {"trigger_key": trigger_key,
            "trigger_label": entry.get("trigger_label"),
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
            "days": days, "history_available": history_available,
            "no_history_reason": reason}


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
            .result(timeout=_BQ_RESULT_TIMEOUT_S)
        )[0].n

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_page, f_total = ex.submit(page), ex.submit(total)
        try:
            return f_page.result(), f_total.result()
        except (FuturesTimeout, TimeoutError) as exc:
            raise PreviewTimeout(
                f"The preview for {trigger_key} did not return within "
                f"{_BQ_RESULT_TIMEOUT_S}s — the query is fine, the wait was not. "
                "Retry; if it persists, check the marketing-portal-api instance."
            ) from exc


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
    enabled = trigger_enabled(trigger_key)  # the portal toggle — does it SEND
    history_available = trigger_key in HISTORY_TRIGGERS
    if days and not history_available:
        rows, n = [], 0
    else:
        rows, n = _preview_rows(trigger_key, q, limit, offset, days)
    return {"trigger_key": trigger_key,
            "trigger_label": None,
            "rows": rows, "total": n,
            "limit": limit, "offset": offset, "cap": cap, "enabled": enabled,
            "days": days, "history_available": history_available,
            "no_history_reason": (
                None if history_available else NO_HISTORY_REASON.get(trigger_key)
            )}
