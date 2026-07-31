"""Portal-managed campaign slug registry + live Customer.io precheck.

The registry moved here from api/config/slugs.yaml so registering a campaign
no longer needs a repo deploy. Rows live in customerio_state.slug_registry;
validator/runner/tripwires keep reading through config.slug_registry(), whose
dict shape is unchanged from the YAML contract.

The precheck is a light subset of the full validator: the campaigns list plus
one actions fetch per trigger half. It answers "do the four campaigns for this
slug actually exist, and is the twin safely wired?" before an entry is saved —
including the dual-entry hazard (twin journey listening on the production
event) that a fresh dupe always starts out with, and the recipient-resolution
hazard (a trigger keying people on a payload field the runner never sends,
which burns a full run timeout to discover dynamically).
"""

import json
import re
from datetime import datetime, timezone

from google.cloud import bigquery

from . import bqstate, payloads
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
        "filter_fields": json.loads(r.get("filter_fields_json") or "[]"),
        "webhook_secrets": json.loads(r.get("webhook_secrets_json") or "[]"),
        "test_webhook_secret": r.get("test_webhook_secret"),
        "test_webhook_url": r.get("test_webhook_url"),
        "payload_template": r.get("payload_template"),
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
      person_attributes_json = @person_attributes, filter_fields_json = @filter_fields,
      webhook_secrets_json = @webhook_secrets,
      test_webhook_secret = @test_webhook_secret, test_webhook_url = @test_webhook_url,
      payload_template = @payload_template,
      notes = @notes, updated_at = CURRENT_TIMESTAMP(), updated_by = @actor
    WHEN NOT MATCHED THEN INSERT
      (slug, trigger_key, event_name, test_event_name, payload_fields_json,
       person_attributes_json, filter_fields_json, webhook_secrets_json, test_webhook_secret,
       test_webhook_url, payload_template, notes, created_at, created_by, updated_at, updated_by)
    VALUES (@slug, @trigger_key, @event_name, @test_event_name, @payload_fields,
            @person_attributes, @filter_fields, @webhook_secrets, @test_webhook_secret,
            @test_webhook_url, @payload_template, @notes, CURRENT_TIMESTAMP(), @actor,
            CURRENT_TIMESTAMP(), @actor)
    """
    params = [
        bigquery.ScalarQueryParameter("slug", "STRING", slug),
        bigquery.ScalarQueryParameter("trigger_key", "STRING", fields.get("trigger_key")),
        bigquery.ScalarQueryParameter("event_name", "STRING", fields.get("event_name")),
        bigquery.ScalarQueryParameter("test_event_name", "STRING", fields.get("test_event_name")),
        bigquery.ScalarQueryParameter("payload_fields", "STRING", json.dumps(fields.get("payload_fields") or [])),
        bigquery.ScalarQueryParameter("person_attributes", "STRING", json.dumps(fields.get("person_attributes") or [])),
        bigquery.ScalarQueryParameter("filter_fields", "STRING", json.dumps(fields.get("filter_fields") or [])),
        bigquery.ScalarQueryParameter("webhook_secrets", "STRING", json.dumps(fields.get("webhook_secrets") or [])),
        bigquery.ScalarQueryParameter("test_webhook_secret", "STRING", fields.get("test_webhook_secret")),
        bigquery.ScalarQueryParameter("test_webhook_url", "STRING", fields.get("test_webhook_url")),
        bigquery.ScalarQueryParameter("payload_template", "STRING", fields.get("payload_template")),
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
        ("filter_fields", "Journey filter field"),
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
    template = fields.get("payload_template")
    if template:
        errors += payloads.template_problems(template)
    test_ev = fields.get("test_event_name")
    if test_ev and not test_ev.startswith(TEST_EVENT_PREFIX):
        errors.append(f"Test trigger event must start with '{TEST_EVENT_PREFIX}' (got '{test_ev}')")
    ev = fields.get("event_name")
    if ev and ev.startswith(TEST_EVENT_PREFIX):
        errors.append("Prod trigger event must not use the pmy_test_ prefix")
    if ev and test_ev and ev == test_ev:
        errors.append("Prod and test trigger events must differ")
    return errors


def _recipient_gaps(actions: list[dict], payload_keys: set[str]) -> list[tuple[str, str]]:
    """(action label, trigger field) for every person-resolving action whose
    recipient rule keys on a payload field the run payload won't carry —
    Customer.io accepts such a webhook and silently resolves nobody."""
    gaps = []
    for a in actions:
        if a.get("type") not in ("attribute_update", "create_event"):
            continue
        try:
            recipient = json.loads(a.get("recipient") or "{}")
        except json.JSONDecodeError:
            continue
        field = recipient.get("value")
        if recipient.get("type") == "trigger_attribute" and field and field not in payload_keys:
            gaps.append((a.get("name") or a.get("type"), field))
    return gaps


def analyze(
    roles: dict[str, dict],
    spec: dict | None,
    secrets: dict[str, bool | None],
    slug: str | None = None,
    trigger_actions: dict[str, list[dict]] | None = None,
) -> list[dict]:
    """Convention findings for a slug's campaigns — pure, so the failure paths
    are testable without CIO/BQ. `roles` is validator._match_campaigns output,
    `spec` the (draft or saved) registry entry, `secrets` id → exists?,
    `trigger_actions` role → campaign_actions for the trigger halves (omitted
    when CIO couldn't supply them — the recipient checks then stay silent).

    Levels: fail = will misbehave, warn = blocks or degrades testing,
    info = expected-but-worth-knowing. A finding may carry a `fix` — a
    registry field/value the portal can apply in one click; only the registry
    side is ever offered, since the App API cannot rename anything in CIO.
    """
    findings: list[dict] = []
    spec = spec or {}

    def add(level: str, message: str, fix: dict | None = None) -> None:
        finding: dict = {"level": level, "message": message}
        if fix:
            finding["fix"] = fix
        findings.append(finding)

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

    convention = TEST_EVENT_PREFIX + slug if slug else None
    expected_test = spec.get("test_event_name")
    if expected_test and test_ev and test_ev != expected_test:
        adopt = {
            "field": "test_event_name",
            "value": test_ev,
            "label": f"Use '{test_ev}' (what Customer.io runs on)",
        }
        if expected_test == convention:
            add(
                "fail",
                f"Registry expects the convention name '{expected_test}' but the twin still runs on "
                f"'{test_ev}' — every run fails on this drift. Keep the convention by renaming the "
                f"twin's trigger AND its [1/2] Send Event in Customer.io to '{expected_test}', or "
                "adopt the current Customer.io name below.",
                fix=adopt,
            )
        else:
            add(
                "fail",
                f"Twin journey triggers on '{test_ev}' but the registry says '{expected_test}'",
                fix=adopt,
            )
    elif convention and test_ev and expected_test == test_ev and test_ev != convention:
        add(
            "info",
            f"This pair runs on legacy event name '{test_ev}'; the convention is '{convention}'. To "
            "adopt it, rename the twin's trigger and its [1/2] Send Event in Customer.io first — "
            "this check will then offer the matching registry update.",
        )
    expected_prod = spec.get("event_name")
    if expected_prod and prod_ev and prod_ev != expected_prod:
        add(
            "warn",
            f"Prod journey triggers on '{prod_ev}' but the registry says '{expected_prod}'",
            fix={
                "field": "event_name",
                "value": prod_ev,
                "label": f"Use '{prod_ev}' (what production runs on)",
            },
        )

    payload_keys = set(payloads.effective_template(spec))
    for role, level in (("test_trigger", "fail"), ("prod_trigger", "warn")):
        acts = (trigger_actions or {}).get(role)
        if not acts:
            continue
        name = (clean.get(role) or {}).get("name") or _ROLE_LABELS[role]
        for action_label, field in _recipient_gaps(acts, payload_keys):
            consequence = (
                "every run fires the webhook, creates nobody, and times out with no profile"
                if role == "test_trigger"
                else "at launch the journey would silently no-op on every real trigger"
            )
            hint = ""
            declared = spec.get("payload_fields") or []
            if declared and field not in declared:
                hint = (
                    f" Note: '{field}' is not in this slug's payload contract either — the "
                    "production relay does not send it."
                )
            add(
                level,
                f'"{name}" resolves people by trigger field \'{field}\' (its {action_label} '
                f"action), but the payload this slug sends has no '{field}' — {consequence}."
                f" Point the action's recipient at 'email' in Customer.io (like the "
                f"Welcome-General twin), or add '{field}' to this slug's payload template if "
                f"the real trigger genuinely carries it.{hint}",
            )

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


def suggested_entry(roles: dict[str, dict], cio, actions_by_role: dict | None = None) -> dict:
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
    role = "prod_trigger" if clean.get("prod_trigger") else "test_trigger"
    trigger = clean.get(role)
    if trigger:
        acts = (actions_by_role or {}).get(role)
        if acts is None:
            try:
                acts = cio.campaign_actions(trigger["id"])
            except Exception:  # noqa: BLE001 — suggestions are best-effort, precheck must still answer
                acts = []
        out["payload_fields"] = _event_mapping_fields(acts)
        out["person_attributes"] = _person_attribute_fields(acts)
    return {k: v for k, v in out.items() if v}


def _person_recipient_field(actions: list[dict]) -> str | None:
    """The trigger field the Create/Update Person action resolves people by."""
    for a in actions:
        if a.get("type") == "attribute_update":
            try:
                recipient = json.loads(a.get("recipient") or "{}")
            except json.JSONDecodeError:
                return None
            if recipient.get("type") == "trigger_attribute":
                return recipient.get("value")
    return None


def _variables_from(spec: dict, clean: dict[str, dict], actions: dict[str, list[dict]]) -> dict:
    """Pure core of the variables panel: what the runner sends, what the
    registry declares, what Customer.io actually maps, and which emails use
    which variables — side by side, so drift is visible at a glance."""
    from .validator import (
        _event_mapping_fields,
        _liquid_ref_sites,
        _liquid_ref_snippets,
        _person_attribute_fields,
    )

    template = payloads.effective_template(spec)
    cio_rows = []
    for role in ("test_trigger", "prod_trigger"):
        c = clean.get(role)
        if not c or role not in actions:
            continue
        acts = actions[role]
        cio_rows.append(
            {
                "role": role,
                "campaign_id": c["id"],
                "campaign_name": c.get("name"),
                "send_event_fields": _event_mapping_fields(acts),
                "person_attribute_fields": _person_attribute_fields(acts),
                "recipient_field": _person_recipient_field(acts),
            }
        )
    liquid = []
    for pair, jrole in (("test", "test_journey"), ("prod", "prod_journey")):
        if jrole not in actions:
            continue
        sites = _liquid_ref_sites(actions[jrole])
        snippets = _liquid_ref_snippets(actions[jrole])
        for scope in ("trigger", "event", "customer"):
            for field, subjects in sorted(sites[scope].items()):
                liquid.append(
                    {
                        "pair": pair,
                        "scope": scope,
                        "field": field,
                        "emails": sorted(subjects),
                        "contexts": snippets[scope].get(field, []),
                    }
                )
    return {
        "slug": spec.get("slug"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "template": {
            "keys": list(template),
            "is_custom": payloads.parse_template(spec.get("payload_template")) is not None,
        },
        "registry": {
            "payload_fields": spec.get("payload_fields") or [],
            "person_attributes": spec.get("person_attributes") or [],
            # Journey entry-filter inputs are declared here, not read live —
            # the App API exposes none of the workflow's filter conditions.
            "filter_fields": spec.get("filter_fields") or [],
        },
        "cio": cio_rows,
        "liquid": liquid,
    }


def _live_roles_actions(slug: str) -> tuple[dict, dict]:
    from .cio import CioClient
    from .validator import _match_campaigns

    cio = CioClient()
    roles = _match_campaigns(cio.campaigns(), slug)
    clean = {k: v for k, v in roles.items() if "duplicate" not in k}
    actions: dict[str, list[dict]] = {}
    for role, c in clean.items():
        try:
            actions[role] = cio.campaign_actions(c["id"])
        except Exception:  # noqa: BLE001 — a role we can't read just drops out of the panel
            pass
    return clean, actions


def variables_report(slug: str) -> dict:
    spec = get_slug(slug) or {"slug": slug}
    clean, actions = _live_roles_actions(slug)
    return _variables_from(spec, clean, actions)


def refresh_variables(slug: str, actor: str | None) -> dict:
    """Overwrite the registry's payload/person contracts with what Customer.io
    maps right now — the explicit-refresh counterpart of the precheck's
    fill-empty-only suggestions."""
    entry = get_slug(slug)
    if entry is None:
        raise KeyError(slug)
    clean, actions = _live_roles_actions(slug)
    role = "prod_trigger" if clean.get("prod_trigger") else "test_trigger"
    acts = actions.get(role)
    if acts:
        from .validator import _event_mapping_fields, _person_attribute_fields

        fields = dict(entry)
        mapped = _event_mapping_fields(acts)
        if mapped:
            fields["payload_fields"] = mapped
        fields["person_attributes"] = sorted(
            set(_person_attribute_fields(acts)) | set(entry.get("person_attributes") or [])
        )
        upsert_slug(slug, fields, actor)
        spec = get_slug(slug)
    else:
        spec = entry
    return _variables_from(spec or entry, clean, actions)


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
    trigger_actions: dict[str, list[dict]] = {}
    for role in ("test_trigger", "prod_trigger"):
        c = roles.get(role)
        if c:
            try:
                trigger_actions[role] = cio.campaign_actions(c["id"])
            except Exception:  # noqa: BLE001 — recipient checks stay silent; the rest must still answer
                pass

    secret_ids = [s for s in [spec.get("test_webhook_secret"), *(spec.get("webhook_secrets") or [])] if s]
    ref_problems = {sid: secret_ref_problem(sid) for sid in dict.fromkeys(secret_ids)}
    secrets = {sid: secret_exists(sid) for sid, p in ref_problems.items() if p is None}

    findings = [{"level": "fail", "message": p} for p in ref_problems.values() if p]
    url = spec.get("test_webhook_url")
    if url and webhook_url_problem(url):
        findings.append({"level": "fail", "message": webhook_url_problem(url)})
    if spec.get("payload_template"):
        findings += [
            {"level": "fail", "message": p} for p in payloads.template_problems(spec["payload_template"])
        ]
    findings += analyze(roles, spec, secrets, slug=slug, trigger_actions=trigger_actions)
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
        "suggested": suggested_entry(roles, cio, actions_by_role=trigger_actions),
        "runnable": runnable,
        "runnable_reason": None if runnable else "no usable test webhook URL registered",
        "payload_preview": payloads.fill(
            payloads.effective_template(spec), "scenario-000@qa.sdfc.dev"
        ),
        "payload_is_custom": payloads.parse_template(spec.get("payload_template")) is not None,
    }
