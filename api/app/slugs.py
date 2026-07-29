"""Portal-managed campaign slug registry + live Customer.io precheck.

The registry moved here from api/config/slugs.yaml so registering a campaign
no longer needs a repo deploy. Rows live in customerio_state.slug_registry;
validator/runner/tripwires keep reading through config.slug_registry(), whose
dict shape is unchanged from the YAML contract.

The precheck is the campaigns-list subset of the full validator: one CIO call,
no per-campaign actions fetches. It answers "do the four campaigns for this
slug actually exist, and is the twin safely wired?" before an entry is saved —
including the dual-entry hazard (twin journey listening on the production
event) that a fresh dupe always starts out with.
"""

import json
import re
from datetime import datetime, timezone

from google.cloud import bigquery

from . import bqstate
from .config import secret_exists

_DATASET = f"{bqstate.GCP_PROJECT}.customerio_state"
_TABLE = f"{_DATASET}.slug_registry"

SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
EVENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{1,255}$")
_URL_LIKE = re.compile(r"^https?://", re.I)
# Stored plainly in the registry (internal-only portal, Dean's call 2026-07-29):
# the twin's webhook URL. Prod URLs stay with the trigger hub's secrets.
WEBHOOK_URL_RE = re.compile(r"^https://api(-eu)?\.customer\.io/v1/webhook/[A-Za-z0-9]+$")


def webhook_url_problem(value: str) -> str | None:
    """Why a value can't be used as the twin's webhook URL, or None if it can."""
    if WEBHOOK_URL_RE.match(value):
        return None
    if not _URL_LIKE.match(value):
        return (
            f"'{value[:70]}' doesn't look like a webhook URL — paste the twin's full trigger "
            "URL (https://api.customer.io/v1/webhook/…) from its [1/2] campaign settings"
        )
    return f"'{value[:70]}' is not a Customer.io webhook URL (expected https://api.customer.io/v1/webhook/…)"


def secret_ref_problem(value: str) -> str | None:
    """Why a value can't be used as a Secret Manager id, or None if it can.
    The common mistake is pasting the webhook URL itself — the URL is the
    credential and belongs INSIDE the secret; the registry only holds the
    secret's name.
    """
    if SECRET_RE.match(value):
        return None
    if _URL_LIKE.match(value):
        return (
            f"'{value[:70]}' is the webhook URL itself — store the URL in Secret Manager "
            "and enter the secret's id here (the URL is the credential; the registry only "
            "holds the secret's name)"
        )
    return f"'{value[:70]}' is not a valid Secret Manager id"

TEST_EVENT_PREFIX = "pmy_test_"

_ROLE_LABELS = {
    "test_trigger": "test trigger [1/2]",
    "test_journey": "test journey [2/2]",
    "prod_trigger": "prod trigger [1/2]",
    "prod_journey": "prod journey [2/2]",
}


def _row_to_entry(r: dict) -> dict:
    entry = {
        "slug": r["slug"],
        "trigger_key": r.get("trigger_key"),
        "event_name": r.get("event_name"),
        "test_event_name": r.get("test_event_name"),
        "payload_fields": json.loads(r.get("payload_fields_json") or "[]"),
        "person_attributes": json.loads(r.get("person_attributes_json") or "[]"),
        "webhook_secrets": json.loads(r.get("webhook_secrets_json") or "[]"),
        "test_webhook_secret": r.get("test_webhook_secret"),
        "test_webhook_url": r.get("test_webhook_url"),
        "notes": r.get("notes"),
        "updated_at": r.get("updated_at"),
        "updated_by": r.get("updated_by"),
    }
    if entry["updated_at"] is not None:
        entry["updated_at"] = entry["updated_at"].isoformat()
    return entry


def list_slugs(q: str | None = None) -> list[dict]:
    where = "TRUE" if not q else "STRPOS(LOWER(slug), LOWER(@q)) > 0"
    params = [] if not q else [bigquery.ScalarQueryParameter("q", "STRING", q)]
    rows = bqstate.client().query(
        f"SELECT * FROM `{_TABLE}` WHERE {where} ORDER BY slug",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    entries = [_row_to_entry(dict(r)) for r in rows]
    for e in entries:
        # "Runnable" = the runner would accept it: a stored webhook URL, or a
        # legacy Secret Manager id (pre-migration entries).
        e["runnable"] = bool(e["test_webhook_url"] or e["test_webhook_secret"])
    return entries


def get_slug(slug: str) -> dict | None:
    rows = list(
        bqstate.client().query(
            f"SELECT * FROM `{_TABLE}` WHERE slug = @slug",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
            ),
        ).result()
    )
    return _row_to_entry(dict(rows[0])) if rows else None


def registry_dict() -> dict:
    """{slug: spec} in the shape the YAML registry used — what validator,
    runner and tripwire provisioning consume via config.slug_registry()."""
    return {e["slug"]: e for e in list_slugs()}


def upsert_slug(slug: str, fields: dict, actor: str | None) -> dict:
    q = f"""
    MERGE `{_TABLE}` t USING (SELECT @slug AS slug) s ON t.slug = s.slug
    WHEN MATCHED THEN UPDATE SET
      trigger_key = @trigger_key, event_name = @event_name,
      test_event_name = @test_event_name, payload_fields_json = @payload_fields,
      person_attributes_json = @person_attributes, webhook_secrets_json = @webhook_secrets,
      test_webhook_secret = @test_webhook_secret, test_webhook_url = @test_webhook_url,
      notes = @notes, updated_at = CURRENT_TIMESTAMP(), updated_by = @actor
    WHEN NOT MATCHED THEN INSERT
      (slug, trigger_key, event_name, test_event_name, payload_fields_json,
       person_attributes_json, webhook_secrets_json, test_webhook_secret, test_webhook_url,
       notes, created_at, created_by, updated_at, updated_by)
    VALUES (@slug, @trigger_key, @event_name, @test_event_name, @payload_fields,
            @person_attributes, @webhook_secrets, @test_webhook_secret, @test_webhook_url,
            @notes, CURRENT_TIMESTAMP(), @actor, CURRENT_TIMESTAMP(), @actor)
    """
    params = [
        bigquery.ScalarQueryParameter("slug", "STRING", slug),
        bigquery.ScalarQueryParameter("trigger_key", "STRING", fields.get("trigger_key")),
        bigquery.ScalarQueryParameter("event_name", "STRING", fields.get("event_name")),
        bigquery.ScalarQueryParameter("test_event_name", "STRING", fields.get("test_event_name")),
        bigquery.ScalarQueryParameter("payload_fields", "STRING", json.dumps(fields.get("payload_fields") or [])),
        bigquery.ScalarQueryParameter("person_attributes", "STRING", json.dumps(fields.get("person_attributes") or [])),
        bigquery.ScalarQueryParameter("webhook_secrets", "STRING", json.dumps(fields.get("webhook_secrets") or [])),
        bigquery.ScalarQueryParameter("test_webhook_secret", "STRING", fields.get("test_webhook_secret")),
        bigquery.ScalarQueryParameter("test_webhook_url", "STRING", fields.get("test_webhook_url")),
        bigquery.ScalarQueryParameter("notes", "STRING", fields.get("notes")),
        bigquery.ScalarQueryParameter("actor", "STRING", actor),
    ]
    bqstate.client().query(q, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    entry = get_slug(slug)
    assert entry is not None
    return entry


def delete_slug(slug: str) -> bool:
    job = bqstate.client().query(
        f"DELETE FROM `{_TABLE}` WHERE slug = @slug",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
        ),
    )
    job.result()
    return bool(job.num_dml_affected_rows)


def validate_entry(fields: dict) -> list[str]:
    """Shape errors for an upsert body; empty list when clean."""
    errors: list[str] = []
    for key, rx, label in (
        ("event_name", EVENT_RE, "Prod trigger event"),
        ("test_event_name", EVENT_RE, "Test trigger event"),
        ("trigger_key", FIELD_RE, "Trigger key"),
    ):
        v = fields.get(key)
        if v and not rx.match(v):
            errors.append(f"{label} '{v}' has an unexpected format")
    for key, label in (
        ("payload_fields", "Payload field"),
        ("person_attributes", "Person attribute"),
    ):
        for v in fields.get(key) or []:
            if not FIELD_RE.match(v):
                errors.append(f"{label} '{v}' has an unexpected format")
    for v in [fields.get("test_webhook_secret"), *(fields.get("webhook_secrets") or [])]:
        problem = secret_ref_problem(v) if v else None
        if problem:
            errors.append(problem)
    url = fields.get("test_webhook_url")
    if url:
        problem = webhook_url_problem(url)
        if problem:
            errors.append(problem)
    test_ev = fields.get("test_event_name")
    if test_ev and not test_ev.startswith(TEST_EVENT_PREFIX):
        errors.append(f"Test trigger event must start with '{TEST_EVENT_PREFIX}' (got '{test_ev}')")
    ev = fields.get("event_name")
    if ev and ev.startswith(TEST_EVENT_PREFIX):
        errors.append("Prod trigger event must not use the pmy_test_ prefix")
    if ev and test_ev and ev == test_ev:
        errors.append("Prod and test trigger events must differ")
    return errors


def analyze(roles: dict[str, dict], spec: dict | None, secrets: dict[str, bool | None]) -> list[dict]:
    """Convention findings for a slug's campaigns — pure, so the failure paths
    are testable without CIO/BQ. `roles` is validator._match_campaigns output,
    `spec` the (draft or saved) registry entry, `secrets` id → exists?.

    Levels: fail = will misbehave, warn = blocks or degrades testing,
    info = expected-but-worth-knowing.
    """
    findings: list[dict] = []
    spec = spec or {}

    def add(level: str, message: str) -> None:
        findings.append({"level": level, "message": message})

    clean = {k: v for k, v in roles.items() if "duplicate" not in k}
    for role in ("test_trigger", "test_journey"):
        if role not in clean:
            add("fail", f"No {_ROLE_LABELS[role]} campaign found — dupe the prod pair before testing")
    for role in ("prod_trigger", "prod_journey"):
        if role not in clean:
            add("warn", f"No {_ROLE_LABELS[role]} campaign found — check the naming convention")
    dupes = [k for k in roles if "duplicate" in k]
    if dupes:
        add("warn", f"Multiple campaigns match the same role ({len(dupes)} duplicate(s)) — names are ambiguous")

    test_ev = (clean.get("test_journey") or {}).get("event_name")
    prod_ev = (clean.get("prod_journey") or {}).get("event_name")
    if test_ev and prod_ev and test_ev == prod_ev:
        add(
            "fail",
            f"Twin journey listens on the PRODUCTION event '{prod_ev}' — once both run, every real "
            "purchase enters both journeys and fans get the series twice. Rename the twin's trigger "
            f"(and its [1/2] Send Event) to '{TEST_EVENT_PREFIX}{prod_ev}'.",
        )
    elif test_ev and not test_ev.startswith(TEST_EVENT_PREFIX):
        add("fail", f"Twin journey triggers on '{test_ev}' — test events must use the {TEST_EVENT_PREFIX} prefix")
    if "test_journey" in clean and not test_ev:
        add("warn", "Twin journey exposes no trigger event — non-event trigger or API lag; verify in Customer.io")

    expected_test = spec.get("test_event_name")
    if expected_test and test_ev and test_ev != expected_test:
        add("fail", f"Twin journey triggers on '{test_ev}' but the registry says '{expected_test}'")
    expected_prod = spec.get("event_name")
    if expected_prod and prod_ev and prod_ev != expected_prod:
        add("warn", f"Prod journey triggers on '{prod_ev}' but the registry says '{expected_prod}'")

    stopped = [
        _ROLE_LABELS[r]
        for r in ("test_trigger", "test_journey")
        if r in clean and clean[r].get("state") != "running"
    ]
    if stopped:
        add("warn", f"Not running yet: {', '.join(stopped)} — start both twin halves before running tests")
    if (clean.get("prod_journey") or {}).get("state") == "draft":
        add("info", "Prod journey is still draft (campaign not launched) — normal before go-live")

    for sid, exists in secrets.items():
        if exists is False:
            add("fail", f"Secret Manager has no secret '{sid}' — create it with the webhook URL")
        elif exists is None:
            add("warn", f"Cannot verify secret '{sid}' (no permission)")

    if not (spec.get("test_webhook_url") or spec.get("test_webhook_secret")):
        add("warn", "No test webhook URL registered — paste the twin's trigger URL so the runner can fire this campaign")

    if not findings:
        add("info", "All existence and convention checks look clean")
    return findings


def suggested_entry(roles: dict[str, dict], cio) -> dict:
    """Registry values discoverable from the workspace alone: event names off
    the journeys, payload/person fields off the trigger half's action
    mappings. A twin still carrying the prod event (fresh dupe) gets the
    pmy_test_ rename target suggested — the registry should hold the intended
    name; the mismatch finding then points at the CIO edit.
    """
    from .validator import _event_mapping_fields, _person_attribute_fields

    clean = {k: v for k, v in roles.items() if "duplicate" not in k}
    prod_ev = (clean.get("prod_journey") or {}).get("event_name")
    test_ev = (clean.get("test_journey") or {}).get("event_name")
    out = {
        "event_name": prod_ev,
        "test_event_name": (
            test_ev
            if test_ev and test_ev.startswith(TEST_EVENT_PREFIX)
            else (TEST_EVENT_PREFIX + prod_ev if prod_ev else None)
        ),
    }
    trigger = clean.get("prod_trigger") or clean.get("test_trigger")
    if trigger:
        try:
            acts = cio.campaign_actions(trigger["id"])
        except Exception:  # noqa: BLE001 — suggestions are best-effort, precheck must still answer
            acts = []
        out["payload_fields"] = _event_mapping_fields(acts)
        out["person_attributes"] = _person_attribute_fields(acts)
    return {k: v for k, v in out.items() if v}


def precheck(slug: str, overrides: dict | None = None) -> dict:
    """Live check: do the four campaigns exist, and is the twin safe to run?

    `overrides` lets the portal form precheck unsaved values (draft event
    names / secret id) before committing the entry.
    """
    from .cio import CioClient
    from .validator import _match_campaigns

    saved = get_slug(slug)
    spec = dict(saved or {})
    spec.update({k: v for k, v in (overrides or {}).items() if v})

    cio = CioClient()
    roles = _match_campaigns(cio.campaigns(), slug)

    secret_ids = [s for s in [spec.get("test_webhook_secret"), *(spec.get("webhook_secrets") or [])] if s]
    ref_problems = {sid: secret_ref_problem(sid) for sid in dict.fromkeys(secret_ids)}
    secrets = {sid: secret_exists(sid) for sid, p in ref_problems.items() if p is None}

    findings = [{"level": "fail", "message": p} for p in ref_problems.values() if p]
    url = spec.get("test_webhook_url")
    if url and webhook_url_problem(url):
        findings.append({"level": "fail", "message": webhook_url_problem(url)})
    findings += analyze(roles, spec, secrets)
    runnable = bool(url and not webhook_url_problem(url)) or (
        bool(spec.get("test_webhook_secret"))
        and secrets.get(spec.get("test_webhook_secret")) is True
    )
    campaigns = [
        {
            "role": role,
            "id": c["id"],
            "name": c["name"],
            "state": c.get("state"),
            "event_name": c.get("event_name"),
        }
        for role, c in roles.items()
        if "duplicate" not in role
    ]
    return {
        "slug": slug,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "registered": saved is not None,
        "campaigns": sorted(campaigns, key=lambda c: str(c["role"])),
        "findings": findings,
        "secrets": secrets,
        "suggested": suggested_entry(roles, cio),
        "runnable": runnable,
        "runnable_reason": None if runnable else "no usable test webhook URL registered",
    }
