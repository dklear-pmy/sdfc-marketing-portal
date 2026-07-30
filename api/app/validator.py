"""Static wiring validation for a campaign slug's CIO twin pairs.

Checks (from repodocs/CIO_TEST_HARNESS_UI_PLAN.md in sdfc-udp):
  1. pair-presence      — all four campaigns found by naming convention
  2. states             — test pair running; prod journey draft surfaced
  3. event-names        — test journey on pmy_test_*; prod journey clean; global lint
  4. identify-by-email  — both trigger halves key the person on the email field
  5. payload-mapping    — Send Event fields match the slug's payload contract
  6. liquid-refs        — template refs resolvable from payload/person attributes
  7. webhook-secret     — a test trigger webhook URL is registered (plain
                          registry URL; legacy Secret Manager id still honored)

Known static blind spots (covered by the Phase-2 dynamic runner): the Send
Event's emitted *event name* and journey timers/branches are not exposed by the
App API.
"""

import argparse
import json
import re
from datetime import datetime, timezone

from .cio import CioClient
from .config import secret_exists, slug_registry

_LIQUID_REF = re.compile(r"\{\{\s*(trigger|customer|event)\.([a-zA-Z0-9_.]+)")


def _check(checks: list, check_id: str, name: str, status: str, detail: str) -> None:
    checks.append({"id": check_id, "name": name, "status": status, "detail": detail})


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


def _event_mapping_fields(actions: list[dict]) -> list[str] | None:
    for a in actions:
        if a.get("type") == "create_event":
            try:
                return [m["name"] for m in json.loads(a.get("body") or "[]")]
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


def _liquid_refs(actions: list[dict]) -> dict[str, set[str]]:
    refs: dict[str, set[str]] = {"trigger": set(), "customer": set(), "event": set()}
    for a in actions:
        if a.get("type") != "email":
            continue
        blob = (a.get("body") or "") + (a.get("body_plain") or "") + (a.get("subject") or "")
        for scope, field in _LIQUID_REF.findall(blob):
            refs[scope].add(field.split(".")[0])
    return refs


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
    missing = [r for r in required if r not in roles]
    duplicates = [r for r in roles if "duplicate" in r]

    if missing:
        _check(
            checks, "pair-presence", "All four campaigns present", "fail",
            f"Missing: {', '.join(missing)}. Found {len(roles)} matching campaign(s) for '{slug}'.",
        )
    elif duplicates:
        _check(
            checks, "pair-presence", "All four campaigns present", "warn",
            f"All roles found but duplicate names exist: {duplicates}",
        )
    else:
        _check(
            checks, "pair-presence", "All four campaigns present", "pass",
            "Test + prod trigger/journey pairs all matched by naming convention.",
        )

    # --- states ---
    state_notes = []
    state_status = "pass"
    for role in ("test_trigger", "test_journey"):
        c = roles.get(role)
        if c and c.get("state") != "running":
            state_status = "fail"
            state_notes.append(f"{role} is {c.get('state')} (must be running)")
    prod_journey = roles.get("prod_journey")
    if prod_journey and prod_journey.get("state") == "draft":
        state_notes.append("prod journey is DRAFT (campaign not launched)")
        if state_status == "pass":
            state_status = "warn"
    prod_trigger = roles.get("prod_trigger")
    if prod_trigger and prod_trigger.get("state") != "running":
        state_notes.append(f"prod trigger is {prod_trigger.get('state')}")
        if state_status == "pass":
            state_status = "warn"
    _check(
        checks, "states", "Campaign states", state_status,
        "; ".join(state_notes) or "Test pair running; prod pair running.",
    )

    # --- event names ---
    expected_test_event = spec.get("test_event_name")
    expected_prod_event = spec.get("event_name")
    ev_status, ev_notes = "pass", []
    tj = roles.get("test_journey")
    if tj:
        ev = tj.get("event_name")
        if not ev:
            ev_status = "warn"
            ev_notes.append("test journey exposes no event_name (draft or non-event trigger?)")
        elif not ev.startswith("pmy_test_"):
            ev_status = "fail"
            ev_notes.append(f"test journey triggers on '{ev}' — must use pmy_test_ prefix")
        elif expected_test_event and ev != expected_test_event:
            ev_status = "fail"
            ev_notes.append(f"test journey on '{ev}', registry expects '{expected_test_event}'")
    pj = roles.get("prod_journey")
    if pj:
        ev = pj.get("event_name")
        if ev is None:
            ev_notes.append("prod journey event_name not visible while draft — verify after launch")
            if ev_status == "pass":
                ev_status = "warn"
        elif ev.startswith("pmy_test_"):
            ev_status = "fail"
            ev_notes.append(f"PROD journey triggers on test event '{ev}'")
        elif expected_prod_event and ev != expected_prod_event:
            ev_status = "fail"
            ev_notes.append(f"prod journey on '{ev}', registry expects '{expected_prod_event}'")
    _check(checks, "event-names", "Journey trigger event names", ev_status, "; ".join(ev_notes) or "Correct pmy_test_ split.")

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
    )

    # --- action-level checks (need per-campaign actions) ---
    actions_by_role: dict[str, list[dict]] = {}
    for role in required:
        c = roles.get(role)
        if c:
            actions_by_role[role] = cio.campaign_actions(c["id"])

    id_status, id_notes = "pass", []
    for role in ("test_trigger", "prod_trigger"):
        acts = actions_by_role.get(role)
        if acts is None:
            continue
        bad = [
            a.get("name") or a.get("type")
            for a in acts
            if a.get("type") in ("attribute_update", "create_event") and not _recipient_is_email(a)
        ]
        if bad:
            id_status = "fail"
            id_notes.append(f"{role}: non-email recipient on {bad}")
    _check(
        checks, "identify-by-email", "Trigger halves identify by email", id_status,
        "; ".join(id_notes) or "Create/Update Person and Send Event both key on trigger email.",
    )

    expected_fields = set(spec.get("payload_fields") or [])
    mappings: dict[str, set[str]] = {}
    map_status, map_notes = "pass", []
    for role in ("test_trigger", "prod_trigger"):
        acts = actions_by_role.get(role)
        if acts is None:
            continue
        fields = _event_mapping_fields(acts)
        if fields is None:
            map_status = "fail"
            map_notes.append(f"{role}: no Send Event action found")
            continue
        mappings[role] = set(fields)
        if expected_fields:
            missing_f = expected_fields - set(fields)
            extra_f = set(fields) - expected_fields
            if missing_f:
                map_status = "fail"
                map_notes.append(f"{role} missing payload fields: {sorted(missing_f)}")
            if extra_f and map_status == "pass":
                map_status = "warn"
            if extra_f:
                map_notes.append(f"{role} extra fields: {sorted(extra_f)}")
    if not expected_fields:
        map_notes.append("slug not in registry — field contract not enforced")
        if map_status == "pass":
            map_status = "warn"
    if len(mappings) == 2 and mappings.get("test_trigger") != mappings.get("prod_trigger"):
        if map_status == "pass":
            map_status = "warn"
        diff = mappings["test_trigger"] ^ mappings["prod_trigger"]
        map_notes.append(f"test/prod Send Event mappings differ on: {sorted(diff)}")
    _check(
        checks, "payload-mapping", "Send Event payload mapping", map_status,
        "; ".join(map_notes) or f"All {len(expected_fields)} contract fields mapped on both pairs.",
    )

    liq_status, liq_notes = "pass", []
    known_person = set(spec.get("person_attributes") or [])
    for pair, trig_role, journey_role in (
        ("test", "test_trigger", "test_journey"),
        ("prod", "prod_trigger", "prod_journey"),
    ):
        j_acts = actions_by_role.get(journey_role)
        if j_acts is None:
            continue
        refs = _liquid_refs(j_acts)
        event_fields = mappings.get(trig_role, set())
        person_fields = set(_person_attribute_fields(actions_by_role.get(trig_role) or [])) | known_person
        gaps = _liquid_gaps(refs, event_fields, person_fields)
        if gaps["trigger"]:
            liq_status = "fail"
            liq_notes.append(f"{pair} journey references trigger.{sorted(gaps['trigger'])} not in event payload")
        if gaps["event"]:
            liq_status = "fail"
            liq_notes.append(
                f"{pair} journey references event.{sorted(gaps['event'])} not in the trigger's Send Event mapping"
            )
        if gaps["customer"]:
            if liq_status == "pass":
                liq_status = "warn"
            liq_notes.append(
                f"{pair} journey references customer.{sorted(gaps['customer'])} — not set by this trigger; verify synced attributes"
            )
    _check(
        checks, "liquid-refs", "Template Liquid references resolvable", liq_status,
        "; ".join(liq_notes) or "All trigger.*/event.*/customer.* references covered.",
    )

    sec_status, sec_notes = "pass", []
    if spec.get("test_webhook_url"):
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
        "; ".join(sec_notes),
    )

    campaign_summaries = [
        {
            "id": c["id"],
            "name": c["name"],
            "role": role,
            "state": c.get("state"),
            "event_name": c.get("event_name"),
        }
        for role, c in roles.items()
        if "duplicate" not in role
    ]
    summary = {s: sum(1 for c in checks if c["status"] == s) for s in ("pass", "fail", "warn", "skip")}
    return {
        "slug": slug,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "campaigns": sorted(campaign_summaries, key=lambda c: c["role"]),
        "checks": checks,
        "summary": summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate CIO wiring for a campaign slug")
    parser.add_argument("slug")
    args = parser.parse_args()
    report = validate_slug(args.slug)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
