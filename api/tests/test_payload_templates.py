"""Payload-template failure paths: token filling, save-time validation, and
the recipient-resolution precheck (a trigger keying people on a field the run
payload never sends — the runs-010/011 class, which previously burned a full
timeout to discover).

Plain asserts, no pytest, no credentials — fill/template_problems/analyze are
all pure.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.payloads import (  # noqa: E402
    DEFAULT_TEMPLATE,
    effective_template,
    fill,
    parse_template,
    template_problems,
)
from app.slugs import _recipient_gaps, analyze  # noqa: E402

IDENTITY = "scenario-012@qa.sdfc.dev"


# --- token filling ---
p = fill(DEFAULT_TEMPLATE, IDENTITY)
assert p["email"] == IDENTITY, p
assert p["activity_id"] == 990000012, "exact token must keep native int type"
assert p["dedup_key"] == "990000012", p
assert p["last_name"] == "Harness 012", "embedded token must substitute as text"
assert p["is_world_cup"] is False, "non-string values must pass through untouched"
assert p["fan_created_at"].endswith("Z") and "T" in p["fan_created_at"], p

# the default template must reproduce the legacy hardcoded shape exactly
assert set(p) == {
    "dedup_key", "email", "activity_id", "campaign_title", "signup_form_family",
    "is_world_cup", "is_new_fan_24h", "fan_created_at", "activity_at",
    "first_name", "last_name", "fan_source", "phone_subscribed",
    "has_season_plan", "postal_code",
}, sorted(p)
assert p["campaign_title"] == "San Diego FC / Stay Informed", p

# nested structures fill recursively; unknown tokens survive literally in fill
nested = fill({"email": "{identity}", "meta": {"ids": ["{num}", "x-{num3}"]}, "keep": "{nope}"}, IDENTITY)
assert nested["meta"]["ids"] == [12, "x-012"], nested
assert nested["keep"] == "{nope}", "fill must not mangle unknown tokens (validation catches them)"

# --- save-time validation ---
assert template_problems(json.dumps({"email": "{identity}", "tm_acct_id": "{num}"})) == []
assert any("not valid JSON" in e for e in template_problems("{nope")), template_problems("{nope")
assert any("JSON object" in e for e in template_problems('["a"]'))
assert any('"email": "{identity}"' in e for e in template_problems(json.dumps({"first_name": "X"})))
assert any('"email": "{identity}"' in e for e in template_problems(json.dumps({"email": "dean@sdfc.dev"}))), (
    "a hardcoded email must be rejected — mail would leave the qa sink"
)
errs = template_problems(json.dumps({"email": "{identity}", "x": "{identiy}"}))
assert any("Unknown token" in e and "{identiy}" in e for e in errs), errs
errs = template_problems(json.dumps({"email": "{identity}", "bad key!": 1}))
assert any("unexpected format" in e for e in errs), errs

# --- parse/effective fallbacks ---
assert parse_template(None) is None and parse_template("junk{") is None and parse_template("[1]") is None
assert effective_template({}) is DEFAULT_TEMPLATE
assert effective_template({"payload_template": '{"email": "{identity}", "a": 1}'}) == {
    "email": "{identity}",
    "a": 1,
}

# --- recipient gaps (pure) ---
def action(atype, name, recipient_value, rtype="trigger_attribute"):
    return {
        "type": atype,
        "name": name,
        "recipient": json.dumps({"field": "id", "type": rtype, "value": recipient_value}),
    }


KEYS = set(DEFAULT_TEMPLATE)
gaps = _recipient_gaps(
    [action("attribute_update", "Create or Update Person 1", "account_id"),
     action("create_event", "Send Event", "email")],
    KEYS,
)
assert gaps == [("Create or Update Person 1", "account_id")], gaps
assert _recipient_gaps([action("attribute_update", "CUP", "email")], KEYS) == []
assert _recipient_gaps([action("email", "Email 1", "account_id")], KEYS) == [], "emails don't resolve recipients"
assert _recipient_gaps([{"type": "attribute_update", "recipient": "junk{"}], KEYS) == []

# --- analyze: the runs-010/011 class surfaces as a precheck fail ---
def campaign(cid, name, state="running", event=None):
    return {"id": cid, "name": name, "state": state, "event_name": event}


ROLES = {
    "test_trigger": campaign(56, "[PMY-TEST] [Trigger] [1/2] Game", event=None),
    "test_journey": campaign(55, "[PMY-TEST] [Journey] [2/2] Game", event="pmy_test_game"),
    "prod_trigger": campaign(47, "[Trigger] [1/2] Game"),
    "prod_journey": campaign(43, "[Journey] [2/2] Game", event="Game"),
}
SPEC = {"test_event_name": "pmy_test_game", "event_name": "Game", "test_webhook_url": None,
        "test_webhook_secret": "sec", "payload_fields": ["email", "tm_acct_id"]}
BAD_ACTIONS = {"test_trigger": [action("attribute_update", "Create or Update Person 1", "account_id")]}

f = analyze(ROLES, SPEC, {"sec": True}, slug="Game", trigger_actions=BAD_ACTIONS)
fails = " | ".join(x["message"] for x in f if x["level"] == "fail")
assert "account_id" in fails and "no profile" in fails, f
assert "payload contract" in fails, "must flag that the relay doesn't send the field either"

# prod trigger with the same defect is a warn (doesn't block testing), not a fail
f = analyze(ROLES, SPEC, {"sec": True}, slug="Game",
            trigger_actions={"prod_trigger": BAD_ACTIONS["test_trigger"]})
warns = " | ".join(x["message"] for x in f if x["level"] == "warn")
assert "account_id" in warns and "no-op" in warns, f
assert "account_id" not in " | ".join(x["message"] for x in f if x["level"] == "fail"), f

# email-keyed twins produce no recipient finding
f = analyze(ROLES, SPEC, {"sec": True}, slug="Game",
            trigger_actions={"test_trigger": [action("attribute_update", "CUP", "email")]})
assert "account_id" not in " | ".join(x["message"] for x in f), f

# a custom template carrying the field silences the finding
spec_t = SPEC | {"payload_template": json.dumps({"email": "{identity}", "account_id": "{num}"})}
f = analyze(ROLES, spec_t, {"sec": True}, slug="Game", trigger_actions=BAD_ACTIONS)
assert "account_id" not in " | ".join(x["message"] for x in f if x["level"] == "fail"), f

# no actions supplied → recipient checks stay silent (CIO hiccup must not false-flag)
f = analyze(ROLES, SPEC, {"sec": True}, slug="Game", trigger_actions=None)
assert "resolves people" not in " | ".join(x["message"] for x in f), f

print("test_payload_templates: all assertions passed")
