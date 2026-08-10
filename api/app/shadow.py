"""Real-data ("shadow") runs: fire the test twin with REAL warehouse candidate
rows — the events the production trigger would fire on — rewritten so nothing
can ever reach a real person.

Two entry points:
- replay(slug, ...): the last N historical events the trigger would have
  fired on (customerio_state.tf_campaign_would_fire_history).
- shadow_tick(): for slugs with shadow_armed, fire a run for every NEW live
  candidate (vw_campaign_would_fire) not yet shadow-run, breaker-capped.

Safety model — THREE independent layers, all of which must hold:
1. sanitize_payload() rewrites the recipient email to a minted
   shadow.*@qa.sdfc.dev address, rewrites every OTHER email-shaped value's
   domain to the sink, and prefixes every profile-identity key (the fields a
   Create/Update Person action can resolve a person BY — the People sync keys
   real profiles on SF account id, so a real account_id in a shadow fire
   would UPDATE THE REAL FAN'S PROFILE) with SHADOW-.
2. assert_sink_only() re-scans the finished payload and raises unless every
   email-shaped token ends in @qa.sdfc.dev. A raise means NO fire.
3. The Mailpit sink itself rejects any recipient outside @qa.sdfc.dev at
   RCPT — the transport-level backstop the whole harness is built on.
"""

import hashlib
import json
import re

import requests
from google.cloud import bigquery

from . import bqstate
from .config import GCP_PROJECT, slug_registry

SINK_DOMAIN = "qa.sdfc.dev"
SHADOW_ID_PREFIX = "SHADOW-"

# Payload keys a CIO campaign can resolve a person BY. Real values here
# address REAL profiles (People sync keys on SF account id; other pairs have
# identified by tm_acct_id). Extend deliberately — never trim.
IDENTITY_KEYS = frozenset(
    {"id", "account_id", "customer_id", "cio_id", "tm_acct_id", "fan_id"}
)

_EMAIL_TOKEN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+")
_HISTORY_TF = f"{GCP_PROJECT}.customerio_state.tf_campaign_would_fire_history"
_LIVE_VIEW = f"{GCP_PROJECT}.customerio_state.vw_campaign_would_fire"

# Live-candidate fires per tick, per slug. A backfill surge (an SF data fix
# re-flipping opportunities) becomes at most this many sink emails per tick,
# never a flood — the shadow twin of the hub's circuit breaker.
SHADOW_TICK_CAP = 5


class ShadowGuardError(ValueError):
    """A sanitized payload still holds something that could reach the world."""


def shadow_identity(email: str, nonce: str) -> str:
    """A sink address that stays recognizably derived from the real one
    (shadow.jane-doe.gmail-com.<tag>@qa.sdfc.dev) but is unique per run —
    reusing an address across runs would tangle their Mailpit searches."""
    local, _, domain = (email or "unknown").lower().partition("@")
    tag = hashlib.sha256(f"{email}|{nonce}".encode()).hexdigest()[:8]
    mangled = re.sub(r"[^a-z0-9]+", "-", f"{local}.{domain}").strip("-")
    # Local parts cap at 64 chars: shadow. + tag + dots = 17 fixed.
    mangled = mangled[: 64 - 17] or "unknown"
    return f"shadow.{mangled}.{tag}@{SINK_DOMAIN}"


def _rewrite_value(key: str, value, identity: str):
    if key.lower() in IDENTITY_KEYS and value is not None and value != "":
        return f"{SHADOW_ID_PREFIX}{value}"
    if isinstance(value, str) and "@" in value:
        # Any other email-shaped value (rep_email, cc fields a future trigger
        # might add) keeps its local part but moves to the sink domain.
        return _EMAIL_TOKEN.sub(lambda m: m.group(0).split("@")[0] + "@" + SINK_DOMAIN, value)
    return value


def sanitize_payload(payload: dict, nonce: str) -> tuple[dict, str]:
    """(sink-safe payload, shadow identity). The identity is both the
    payload's `email` value and the address the run engages via Mailpit."""
    if not isinstance(payload, dict):
        raise ShadowGuardError("payload must be a JSON object")
    email = payload.get("email")
    if not email or "@" not in str(email):
        raise ShadowGuardError("candidate row has no usable email to rewrite")
    identity = shadow_identity(str(email), nonce)

    def walk(value, key=""):
        if isinstance(value, dict):
            return {k: walk(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v, key) for v in value]
        if key == "email":
            return identity
        return _rewrite_value(key, value, identity)

    clean = walk(payload)
    assert_sink_only(clean)
    return clean, identity


def assert_sink_only(payload: dict) -> None:
    """Independent re-scan of the OUTGOING bytes: every email-shaped token
    anywhere in the payload must end in @qa.sdfc.dev, or we refuse to fire."""
    serialized = json.dumps(payload)
    for token in _EMAIL_TOKEN.findall(serialized):
        if not token.lower().endswith("@" + SINK_DOMAIN):
            raise ShadowGuardError(
                f"sanitized payload still contains a non-sink address '{token}' — refusing to fire"
            )


def _rows(query: str, params: list) -> list[dict]:
    client = bigquery.Client(project=GCP_PROJECT)
    return [
        dict(r)
        for r in client.query(
            query, job_config=bigquery.QueryJobConfig(query_parameters=params)
        ).result()
    ]


def history_candidates(trigger_key: str, limit: int, history_days: int) -> list[dict]:
    rows = _rows(
        f"""
        SELECT dedup_key, email, first_name, last_name, event_at, payload_json
        FROM `{_HISTORY_TF}`(@days)
        WHERE trigger = @key
        ORDER BY event_at DESC
        LIMIT @lim
        """,
        [
            bigquery.ScalarQueryParameter("days", "INT64", history_days),
            bigquery.ScalarQueryParameter("key", "STRING", trigger_key),
            bigquery.ScalarQueryParameter("lim", "INT64", limit),
        ],
    )
    for r in rows:
        if r.get("event_at"):
            r["event_at"] = r["event_at"].isoformat()
    return rows


def live_candidates(trigger_key: str) -> list[dict]:
    return _rows(
        f"""
        SELECT dedup_key, email, first_name, last_name, payload_json
        FROM `{_LIVE_VIEW}`
        WHERE trigger = @key
        """,
        [bigquery.ScalarQueryParameter("key", "STRING", trigger_key)],
    )


def start_real_run(slug: str, candidate: dict, actor: str | None) -> dict:
    """One shadow run: sanitize the real row, fire the TEST twin webhook,
    hand the run to the normal engagement/assert machinery."""
    from .runner import _tl, _webhook_url  # late import — runner imports nothing from here

    spec = slug_registry().get(slug)
    if not spec or not (spec.get("test_webhook_url") or spec.get("test_webhook_secret")):
        raise ValueError(f"slug '{slug}' has no test webhook URL in the registry")

    raw = json.loads(candidate["payload_json"])
    source_key = str(candidate["dedup_key"])
    run_id = bqstate.create_run(
        slug,
        "open_click_all",
        actor,
        mode="shadow",
        identity="pending",  # replaced below — the identity derives from the run id
        source_key=source_key,
    )
    payload, identity = sanitize_payload(raw, nonce=run_id)
    bqstate.set_run_identity(run_id, identity)
    run = bqstate.get_run(run_id)

    resp = requests.post(_webhook_url(spec), json=payload, timeout=20)
    if resp.status_code not in (200, 202):
        bqstate.update_run(
            run_id,
            status="FAILED",
            stage="fired",
            timeline=_tl(run, "fired", f"webhook HTTP {resp.status_code}: {resp.text[:200]}"),
            detail="Webhook rejected the payload",
        )
        return bqstate.get_run(run_id)

    bqstate.update_run(
        run_id,
        status="RUNNING",
        stage="fired",
        timeline=_tl(
            run,
            "fired",
            f"webhook HTTP {resp.status_code} for {identity} "
            f"(shadow of real event {source_key})",
            payload=payload,
        ),
    )
    return bqstate.get_run(run_id)


def replay(slug: str, limit: int, history_days: int, actor: str | None) -> dict:
    """Fire shadow runs for the last `limit` real events not yet shadow-run."""
    spec = slug_registry().get(slug)
    if not spec:
        raise ValueError(f"slug '{slug}' is not registered")
    trigger_key = spec.get("trigger_key")
    if not trigger_key:
        raise ValueError(f"slug '{slug}' has no trigger_key — real-data runs need one")

    already = bqstate.shadow_source_keys(slug)
    candidates = [
        c for c in history_candidates(trigger_key, limit + len(already), history_days)
        if str(c["dedup_key"]) not in already
    ][:limit]
    runs = [start_real_run(slug, c, actor) for c in candidates]
    return {
        "requested": limit,
        "fired": len(runs),
        "skipped_already_run": len(already),
        "runs": runs,
    }


def shadow_tick() -> list[dict]:
    """For every shadow-armed slug: fire runs for live candidates that have
    not been shadow-run yet, capped per tick."""
    results = []
    for slug, spec in slug_registry().items():
        if not spec.get("shadow_armed") or not spec.get("trigger_key"):
            continue
        already = bqstate.shadow_source_keys(slug)
        fresh = [
            c for c in live_candidates(spec["trigger_key"])
            if str(c["dedup_key"]) not in already
        ]
        for candidate in fresh[:SHADOW_TICK_CAP]:
            try:
                run = start_real_run(slug, candidate, actor="shadow-tick")
                results.append({"slug": slug, "run_id": run["run_id"], "status": run["status"]})
            except ShadowGuardError as e:
                results.append({"slug": slug, "error": str(e)})
        if len(fresh) > SHADOW_TICK_CAP:
            results.append(
                {"slug": slug, "deferred": len(fresh) - SHADOW_TICK_CAP,
                 "detail": "over the per-tick cap; next tick continues"}
            )
    return results
