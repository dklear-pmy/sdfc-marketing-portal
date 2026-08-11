"""Static wiring validation for a campaign slug's CIO twin pairs.

Checks are SCOPED (from repodocs/CIO_TEST_HARNESS_UI_PLAN.md in sdfc-udp):
  test  — the twin pair; must be green before testing: presence, running,
          pmy_test_ event, identify-by-email, Send Event mapping, payload
          template lint, Liquid refs, measured journey delays, webhook URL
  prod  — the live pair; issues to resolve before launch, never test
          blockers: presence, state, event name, identify-by-email, Send
          Event mapping (+ parity with the twin), Liquid refs, webhook URL
  workspace — pmy-test-lint: no live campaign may run on a pmy_test_* event

Known static blind spots (covered by the Phase-2 dynamic runner): the Send
Event's emitted *event name* and journey timers/branches are not exposed by the
App API.
"""

import argparse
import json
import re
from datetime import datetime, timezone

from . import payloads
from .cio import CioClient, campaign_url
from .config import secret_exists, slug_registry

_LIQUID_REF = re.compile(r"\{\{\s*(trigger|customer|event)\.([a-zA-Z0-9_.]+)")


def _check(
    checks: list, check_id: str, name: str, status: str, detail: str, scope: str = "test"
) -> None:
    """scope: 'test' (the twin pair — must be green before testing), 'prod'
    (the live pair — issues to resolve before launch, not test blockers), or
    'workspace' (cross-campaign lint). The UI groups by scope so a healthy
    twin never reads as failing because prod hasn't launched yet."""
    checks.append(
        {"id": check_id, "name": name, "status": status, "detail": detail, "scope": scope}
    )


def _match_campaigns(campaigns: list[dict], slug: str) -> dict[str, dict]:
    """Classify campaigns whose name contains the slug into the four roles."""
    roles: dict[str, dict] = {}
    for c in campaigns:
        name = c.get("name") or ""
        if slug.lower() not in name.lower():
            continue
        is_test = "PMY-TEST" in name.upper()
        if "[1/2]" in name or "[Trigger]" in name:
            half = "trigger"
        elif "[2/2]" in name or "[Journey]" in name:
            half = "journey"
        else:
            continue
        role = f"{'test' if is_test else 'prod'}_{half}"
        # Prefer first match; duplicate names for a role are themselves a finding.
        if role in roles:
            roles[f"{role}_duplicate_{c['id']}"] = c
        else:
            roles[role] = c
    return roles


def _recipient_is_email(action: dict) -> bool:
    try:
        recipient = json.loads(action.get("recipient") or "{}")
    except json.JSONDecodeError:
        return False
    return (
        recipient.get("type") == "trigger_attribute" and recipient.get("value") == "email"
    )


# JS-mode Send Event bodies ('editor': 'js') carry source like
#   return { "order_id": trigger.order_id, ... };
# — capture each event-data key that forwards a trigger field. Static values
# in the JS are invisible here by design: the contract comparison cares about
# which trigger fields ride through to the journey event.
_JS_EVENT_KEY = re.compile(r"[\"']?([A-Za-z0-9_.-]+)[\"']?\s*:\s*trigger\.([A-Za-z0-9_]+)")


def _event_mapping_fields(actions: list[dict]) -> list[str] | None:
    for a in actions:
        if a.get("type") == "create_event":
            body = a.get("body") or ""
            if a.get("editor") == "js":
                seen: set[str] = set()
                fields = []
                for key, _src in _JS_EVENT_KEY.findall(body):
                    if key not in seen:
                        seen.add(key)
                        fields.append(key)
                return fields or None
            try:
                return [m["name"] for m in json.loads(body or "[]")]
            except (json.JSONDecodeError, KeyError, TypeError):
                return None
    return None


def _person_attribute_fields(actions: list[dict]) -> list[str]:
    for a in actions:
        if a.get("type") == "attribute_update":
            try:
                return [m["name"] for m in json.loads(a.get("body") or "[]")]
            except (json.JSONDecodeError, KeyError, TypeError):
                return []
    return []


def _liquid_ref_sites(actions: list[dict]) -> dict[str, dict[str, set[str]]]:
    """scope → field → the email subjects referencing it, so a finding can
    point at the exact message the tester needs to edit."""
    sites: dict[str, dict[str, set[str]]] = {"trigger": {}, "customer": {}, "event": {}}
    for a in actions:
        if a.get("type") != "email":
            continue
        label = a.get("subject") or a.get("name") or f"action {a.get('id')}"
        blob = (a.get("body") or "") + (a.get("body_plain") or "") + (a.get("subject") or "")
        for scope, field in _LIQUID_REF.findall(blob):
            sites[scope].setdefault(field.split(".")[0], set()).add(label)
    return sites


def _liquid_refs(actions: list[dict]) -> dict[str, set[str]]:
    return {scope: set(fields) for scope, fields in _liquid_ref_sites(actions).items()}


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _liquid_ref_snippets(actions: list[dict]) -> dict[str, dict[str, list[dict]]]:
    """scope → field → [{email, context}] where context is the reference with
    up to ten words of surrounding email text on each side — enough to see how
    a variable is actually used without opening the template."""
    out: dict[str, dict[str, list[dict]]] = {"trigger": {}, "customer": {}, "event": {}}
    for a in actions:
        if a.get("type") != "email":
            continue
        label = a.get("subject") or a.get("name") or f"action {a.get('id')}"
        raw = a.get("body_plain") or _TAG.sub(" ", a.get("body") or "")
        text = _WS.sub(" ", f"{a.get('subject') or ''} {raw}").strip()
        seen: set[tuple[str, str]] = set()
        for m in _LIQUID_REF.finditer(text):
            scope, field = m.group(1), m.group(2).split(".")[0]
            if (scope, field) in seen:
                continue
            seen.add((scope, field))
            close = text.find("}}", m.end())
            end = close + 2 if close != -1 else m.end()
            before = text[: m.start()].split()
            after = text[end:].split()
            context = " ".join(
                (["…"] if len(before) > 10 else [])
                + before[-10:]
                + [text[m.start() : end]]
                + after[:10]
                + (["…"] if len(after) > 10 else [])
            )
            out[scope].setdefault(field, []).append({"email": label, "context": context})
    return out


def _liquid_gaps(
    refs: dict[str, set[str]], event_fields: set[str], person_fields: set[str]
) -> dict[str, set[str]]:
    """Template references nothing supplies. trigger.* and event.* both read
    the triggering event's payload, so both resolve against the Send Event
    mapping; customer.* resolves against attributes the trigger sets plus
    registry-known synced attributes. With no readable mapping the event
    scopes can't be judged, so they stay empty rather than false-flagging."""
    return {
        "trigger": refs["trigger"] - event_fields if event_fields else set(),
        "event": refs["event"] - event_fields if event_fields else set(),
        "customer": refs["customer"] - person_fields,
    }


def validate_slug(slug: str) -> dict:
    registry = slug_registry()
    spec = registry.get(slug, {})
    cio = CioClient()
    campaigns = cio.campaigns()
    checks: list[dict] = []

    roles = _match_campaigns(campaigns, slug)
    required = ["test_trigger", "test_journey", "prod_trigger", "prod_journey"]

    # --- presence, split by pair: missing twins block testing (fail); missing
    # prod halves are pre-launch state (warn) ---
    for side, side_roles in (("test", ("test_trigger", "test_journey")), ("prod", ("prod_trigger", "prod_journey"))):
        missing = [r for r in side_roles if r not in roles]
        dupes = [r for r in roles if "duplicate" in r and r.startswith(side)]
        if missing:
            _check(
                checks, f"{side}-pair-presence",
                "Twin pair present" if side == "test" else "Prod pair present",
                "fail" if side == "test" else "warn",
                f"Missing: {', '.join(missing)}."
                + (" Dupe the prod pair into [PMY-TEST] twins before testing." if side == "test"
                   else " Create before launch."),
                scope=side,
            )
        elif dupes:
            _check(
                checks, f"{side}-pair-presence",
                "Twin pair present" if side == "test" else "Prod pair present",
                "warn", f"Roles found but duplicate names exist: {dupes}", scope=side,
            )
        else:
            _check(
                checks, f"{side}-pair-presence",
                "Twin pair present" if side == "test" else "Prod pair present",
                "pass", "Both halves matched by naming convention.", scope=side,
            )

    # --- states, split by pair ---
    t_notes = [
        f"{role} is {roles[role].get('state')} (must be running)"
        for role in ("test_trigger", "test_journey")
        if roles.get(role) and roles[role].get("state") != "running"
    ]
    _check(
        checks, "test-states", "Twin pair running",
        "fail" if t_notes else "pass",
        "; ".join(t_notes) or "Both twin halves running.", scope="test",
    )
    p_notes = []
    prod_journey = roles.get("prod_journey")
    if prod_journey and prod_journey.get("state") == "draft":
        p_notes.append("prod journey is DRAFT (campaign not launched) — normal before go-live")
    prod_trigger = roles.get("prod_trigger")
    if prod_trigger and prod_trigger.get("state") != "running":
        p_notes.append(f"prod trigger is {prod_trigger.get('state')}")
    _check(
        checks, "prod-states", "Prod pair state",
        "warn" if p_notes else "pass",
        "; ".join(p_notes) or "Prod pair running.", scope="prod",
    )

    # --- event names, split by pair ---
    expected_test_event = spec.get("test_event_name")
    expected_prod_event = spec.get("event_name")
    tev_status, tev_notes = "pass", []
    tj = roles.get("test_journey")
    if tj:
        ev = tj.get("event_name")
        if not ev:
            tev_status = "warn"
            tev_notes.append("test journey exposes no event_name (draft or non-event trigger?)")
        elif not ev.startswith("pmy_test_"):
            tev_status = "fail"
            tev_notes.append(f"test journey triggers on '{ev}' — must use pmy_test_ prefix")
        elif expected_test_event and ev != expected_test_event:
            tev_status = "fail"
            tev_notes.append(f"test journey on '{ev}', registry expects '{expected_test_event}'")
    _check(
        checks, "test-event-name", "Twin trigger event", tev_status,
        "; ".join(tev_notes) or "Twin journey on the registered pmy_test_ event.", scope="test",
    )
    pev_status, pev_notes = "pass", []
    pj = roles.get("prod_journey")
    if pj:
        ev = pj.get("event_name")
        if ev is None:
            pev_status = "warn"
            pev_notes.append("prod journey event_name not visible while draft — verify after launch")
        elif ev.startswith("pmy_test_"):
            pev_status = "fail"
            pev_notes.append(
                f"PROD journey triggers on test event '{ev}' — rename before launch or every "
                "harness fire enters production"
            )
        elif expected_prod_event and ev != expected_prod_event:
            pev_status = "fail"
            pev_notes.append(f"prod journey on '{ev}', registry expects '{expected_prod_event}'")
    _check(
        checks, "prod-event-name", "Prod trigger event", pev_status,
        "; ".join(pev_notes) or "Prod journey on the registered production event.", scope="prod",
    )

    # --- global lint: no live campaign on pmy_test_* ---
    violations = [
        f"#{c['id']} {c['name']}"
        for c in campaigns
        if str(c.get("event_name") or "").startswith("pmy_test_")
        and "PMY-TEST" not in (c.get("name") or "").upper()
    ]
    _check(
        checks, "pmy-test-lint", "No live campaign on pmy_test_* events",
        "fail" if violations else "pass",
        "; ".join(violations) or "Workspace-wide scan clean.",
        scope="workspace",
    )

    # --- action-level checks (need per-campaign actions) ---
    actions_by_role: dict[str, list[dict]] = {}
    for role in required:
        c = roles.get(role)
        if c:
            actions_by_role[role] = cio.campaign_actions(c["id"])

    payload_keys = set(payloads.effective_template(spec))
    for side, role in (("test", "test_trigger"), ("prod", "prod_trigger")):
        acts = actions_by_role.get(role)
        title = ("Twin" if side == "test" else "Prod") + " trigger identifies by email"
        if acts is None:
            _check(checks, f"{side}-identify", title, "skip",
                   f"no {side} trigger campaign yet", scope=side)
            continue
        id_status, id_notes = "pass", []
        for a in acts:
            if a.get("type") not in ("attribute_update", "create_event") or _recipient_is_email(a):
                continue
            try:
                recipient = json.loads(a.get("recipient") or "{}")
            except json.JSONDecodeError:
                recipient = {}
            field = recipient.get("value") or "?"
            label = a.get("name") or a.get("type")
            if recipient.get("type") == "trigger_attribute" and field in payload_keys:
                if id_status == "pass":
                    id_status = "warn"
                id_notes.append(
                    f"{label} keys on '{field}' — works (the payload carries it) "
                    "but 'email' is the convention"
                )
            else:
                id_status = "fail"
                id_notes.append(
                    f"{label} resolves people by '{field}', which this slug's payload "
                    "does not carry — the action silently resolves nobody"
                )
        _check(
            checks, f"{side}-identify", title, id_status,
            "; ".join(id_notes) or "Create/Update Person and Send Event both key on trigger email.",
            scope=side,
        )

    expected_fields = set(spec.get("payload_fields") or [])
    mappings: dict[str, set[str]] = {}
    for side, role in (("test", "test_trigger"), ("prod", "prod_trigger")):
        acts = actions_by_role.get(role)
        title = ("Twin" if side == "test" else "Prod") + " Send Event mapping"
        if acts is None:
            _check(checks, f"{side}-payload-mapping", title, "skip",
                   f"no {side} trigger campaign yet", scope=side)
            continue
        map_status, map_notes = "pass", []
        fields = _event_mapping_fields(acts)
        if fields is None:
            map_status = "fail"
            map_notes.append("no Send Event action found")
        else:
            mappings[role] = set(fields)
            if expected_fields:
                missing_f = expected_fields - set(fields)
                extra_f = set(fields) - expected_fields
                if missing_f:
                    map_status = "fail"
                    map_notes.append(f"missing payload fields: {sorted(missing_f)}")
                if extra_f:
                    if map_status == "pass":
                        map_status = "warn"
                    map_notes.append(f"extra fields: {sorted(extra_f)}")
            else:
                map_status = "warn"
                map_notes.append("slug not in registry — field contract not enforced")
        # Pair parity rides on the prod side: the twin is the reference copy.
        if side == "prod" and len(mappings) == 2 and mappings["test_trigger"] != mappings["prod_trigger"]:
            if map_status == "pass":
                map_status = "warn"
            diff = mappings["test_trigger"] ^ mappings["prod_trigger"]
            map_notes.append(f"differs from the twin's mapping on: {sorted(diff)}")
        _check(
            checks, f"{side}-payload-mapping", title, map_status,
            "; ".join(map_notes) or f"All {len(expected_fields)} contract fields mapped.",
            scope=side,
        )

    tmpl_raw = spec.get("payload_template")
    if not spec:
        tmpl_status, tmpl_detail = "skip", "slug not in registry"
    elif not tmpl_raw:
        tmpl_status, tmpl_detail = "pass", "no custom template — runner uses the signup default"
    else:
        tmpl_problems = payloads.template_problems(tmpl_raw)
        tmpl_status = "fail" if tmpl_problems else "pass"
        tmpl_detail = "; ".join(tmpl_problems) or "custom template valid; email pinned to {identity}"
    _check(checks, "payload-template", "Payload template lint", tmpl_status, tmpl_detail, scope="test")

    known_person = set(spec.get("person_attributes") or [])
    for pair, trig_role, journey_role in (
        ("test", "test_trigger", "test_journey"),
        ("prod", "prod_trigger", "prod_journey"),
    ):
        title = ("Twin" if pair == "test" else "Prod") + " email Liquid references"
        j_acts = actions_by_role.get(journey_role)
        if j_acts is None:
            _check(checks, f"{pair}-liquid-refs", title, "skip",
                   f"no {pair} journey campaign yet", scope=pair)
            continue
        liq_status, liq_notes = "pass", []
        sites = _liquid_ref_sites(j_acts)
        refs = {scope: set(fields) for scope, fields in sites.items()}
        event_fields = mappings.get(trig_role, set())
        person_fields = set(_person_attribute_fields(actions_by_role.get(trig_role) or [])) | known_person
        gaps = _liquid_gaps(refs, event_fields, person_fields)
        trigger_name = (roles.get(trig_role) or {}).get("name") or f"the {pair} [1/2] trigger"

        def _used_in(scope: str, field: str) -> str:
            return ", ".join(f"'{s}'" for s in sorted(sites[scope].get(field, set()))) or "?"

        for scope in ("trigger", "event"):
            for field in sorted(gaps[scope]):
                liq_status = "fail"
                liq_notes.append(
                    f"{{{{{scope}.{field}}}}} in email {_used_in(scope, field)} has no source — "
                    f"add '{field}' to the Send Event data mapping in \"{trigger_name}\" "
                    "(Workflow → Send Event action), or remove it from that email"
                )
        for field in sorted(gaps["customer"]):
            if liq_status == "pass":
                liq_status = "warn"
            liq_notes.append(
                f"{{{{customer.{field}}}}} in email {_used_in('customer', field)} is not set by "
                f"\"{trigger_name}\" — set it in that campaign's Create/Update Person action, add it to "
                "this slug's person attributes in the registry if a sync supplies it, or remove it from that email"
            )
        _check(
            checks, f"{pair}-liquid-refs", title, liq_status,
            "; ".join(liq_notes) or "All trigger.*/event.*/customer.* references covered.",
            scope=pair,
        )

    # Delay/window/branch blocks are invisible to the App API (actions expose
    # messages only), so delays are MEASURED from harness-run delivery gaps.
    delay_status = "warn"
    delay_detail = (
        "Delays can't be read statically — no completed run has measured them yet; "
        "start a run to profile this journey's delay blocks."
    )
    try:
        from .bqstate import get_run, list_runs

        for r in list_runs(q=slug, limit=5):
            full = get_run(r["run_id"]) or {}
            entry = next(
                (e for e in reversed(full.get("timeline") or []) if e.get("stage") == "delay_profile"),
                None,
            )
            if entry:
                long_blocks = "(>5m)" in entry["detail"]
                delay_status = "warn" if long_blocks else "pass"
                delay_detail = f"Measured on {r['run_id']}: {entry['detail']}"
                break
    except Exception as e:  # noqa: BLE001 — a state hiccup must not sink the whole validation
        delay_detail = f"delay measurement unavailable: {str(e)[:120]}"
    _check(
        checks, "journey-delays", "Journey delay blocks (≤5 min for smoke runs)",
        delay_status, delay_detail, scope="test",
    )

    from .slugs import webhook_url_problem  # deferred — slugs and validator import each other

    sec_status, sec_notes = "pass", []
    if spec.get("test_webhook_url"):
        url_problem = webhook_url_problem(spec["test_webhook_url"])
        if url_problem:
            sec_status = "fail"
            sec_notes.append(url_problem)
        elif spec.get("test_webhook_url") == spec.get("prod_webhook_url"):
            sec_status = "fail"
            sec_notes.append(
                "identical to the prod webhook URL — one of the two is pasted in the wrong field"
            )
        else:
            sec_notes.append("twin trigger URL stored in the registry")
    elif spec.get("test_webhook_secret"):
        exists = secret_exists(spec["test_webhook_secret"])
        if exists is False:
            sec_status = "fail"
            sec_notes.append(f"legacy secret '{spec['test_webhook_secret']}' not found in Secret Manager")
        elif exists is None:
            sec_status = "warn"
            sec_notes.append(f"legacy secret '{spec['test_webhook_secret']}': no permission to verify")
        else:
            sec_notes.append(f"legacy secret '{spec['test_webhook_secret']}' verified")
    elif spec:
        sec_status = "warn"
        sec_notes.append("no test webhook URL in the registry — the runner cannot fire this slug")
    else:
        sec_status = "skip"
        sec_notes.append("slug not in registry")
    _check(
        checks, "webhook-secret", "Test trigger webhook URL", sec_status,
        "; ".join(sec_notes), scope="test",
    )

    if not spec:
        _check(checks, "prod-webhook-url", "Prod webhook URL", "skip",
               "slug not in registry", scope="prod")
    elif spec.get("prod_webhook_url"):
        p_problem = webhook_url_problem(spec["prod_webhook_url"])
        _check(
            checks, "prod-webhook-url", "Prod webhook URL",
            "fail" if p_problem else "pass",
            p_problem or "live trigger URL stored — sample sends and hub arming can use it",
            scope="prod",
        )
    else:
        _check(
            checks, "prod-webhook-url", "Prod webhook URL", "warn",
            "not stored — needed for composer sample sends and for arming the trigger hub",
            scope="prod",
        )

    campaign_summaries = [
        {
            "id": c["id"],
            "name": c["name"],
            "role": role,
            "state": c.get("state"),
            "event_name": c.get("event_name"),
            "url": campaign_url(c["id"]),
        }
        for role, c in roles.items()
        if "duplicate" not in role
    ]
    summary = {s: sum(1 for c in checks if c["status"] == s) for s in ("pass", "fail", "warn", "skip")}
    scopes = {
        scope: {
            s: sum(1 for c in checks if c["scope"] == scope and c["status"] == s)
            for s in ("pass", "fail", "warn", "skip")
        }
        for scope in ("test", "prod", "workspace")
    }
    return {
        "slug": slug,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "campaigns": sorted(campaign_summaries, key=lambda c: c["role"]),
        "checks": checks,
        "summary": summary,
        "scopes": scopes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate CIO wiring for a campaign slug")
    parser.add_argument("slug")
    args = parser.parse_args()
    report = validate_slug(args.slug)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
