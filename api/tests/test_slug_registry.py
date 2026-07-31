"""Failure-path tests for the slug registry precheck and entry validation.

Plain asserts, no pytest, no credentials — analyze() and validate_entry() are
pure, so every finding class is pinned without touching CIO, BQ or Secret
Manager. The dual-entry case (twin journey listening on the production event)
is the one that would double-send to real fans, so its failure path gets the
most attention.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.slugs import (  # noqa: E402
    TEST_EVENT_PREFIX,
    analyze,
    secret_ref_problem,
    suggested_entry,
    validate_entry,
    webhook_url_problem,
)


def campaign(cid, name, state="running", event=None):
    return {"id": cid, "name": name, "state": state, "event_name": event}


def roles4(test_event="pmy_test_shop", prod_event="Shop-260715", test_state="running", prod_state="running"):
    return {
        "test_trigger": campaign(53, "[PMY-TEST] [Trigger] [1/2] Shop-260715", test_state),
        "test_journey": campaign(54, "[PMY-TEST] [Journey] [2/2] Shop-260715", test_state, test_event),
        "prod_trigger": campaign(46, "[Trigger] [1/2] Shop-260715", prod_state),
        "prod_journey": campaign(44, "[Journey] [2/2] Shop-260715", prod_state, prod_event),
    }


def levels(findings):
    return {f["level"] for f in findings}


def messages(findings, level=None):
    return " | ".join(f["message"] for f in findings if level is None or f["level"] == level)


SPEC = {"test_event_name": "pmy_test_shop", "event_name": "Shop-260715", "test_webhook_secret": "sec-dev"}


# --- clean wiring: no fails, no warns ---
f = analyze(roles4(), SPEC, {"sec-dev": True})
assert levels(f) == {"info"}, f

# --- dual-entry: twin listens on the prod event ---
f = analyze(roles4(test_event="Shop-260715"), SPEC, {"sec-dev": True})
assert "PRODUCTION event" in messages(f, "fail"), f
assert TEST_EVENT_PREFIX + "Shop-260715" in messages(f, "fail"), "fix hint must name the target event"

# --- wrong prefix on a distinct test event ---
f = analyze(roles4(test_event="shop_test"), SPEC | {"test_event_name": None}, {"sec-dev": True})
assert TEST_EVENT_PREFIX in messages(f, "fail"), f

# --- registry/test event mismatch, with the CIO name offered as a one-click fix ---
f = analyze(roles4(test_event="pmy_test_other"), SPEC, {"sec-dev": True})
assert "registry says 'pmy_test_shop'" in messages(f, "fail"), f
fix = next((x["fix"] for x in f if x.get("fix", {}).get("field") == "test_event_name"), None)
assert fix and fix["value"] == "pmy_test_other", f

# --- registry already on the pmy_test_<slug> convention: instruct the CIO
# rename that keeps it, and offer the registry revert as the alternative ---
conv_spec = SPEC | {"test_event_name": "pmy_test_Shop-260715"}
f = analyze(roles4(test_event="pmy_test_shop"), conv_spec, {"sec-dev": True}, slug="Shop-260715")
msg = messages(f, "fail")
assert "convention name 'pmy_test_Shop-260715'" in msg and "Send Event" in msg, f
fix = next((x["fix"] for x in f if x.get("fix", {}).get("field") == "test_event_name"), None)
assert fix and fix["value"] == "pmy_test_shop", f

# --- consistent legacy name: info nudge toward the convention, no button
# (applying the registry side first would CREATE the drift) ---
f = analyze(roles4(), SPEC, {"sec-dev": True}, slug="Shop-260715")
nudges = [x for x in f if x["level"] == "info" and "convention is 'pmy_test_Shop-260715'" in x["message"]]
assert nudges and not any(x.get("fix") for x in nudges), f

# --- prod-side mismatch offers what production actually runs on ---
f = analyze(roles4(prod_event="Shop-Other"), SPEC, {"sec-dev": True})
fix = next((x["fix"] for x in f if x.get("fix", {}).get("field") == "event_name"), None)
assert fix and fix["value"] == "Shop-Other", f

# --- missing twin pair is a fail; missing prod pair only warns ---
r = roles4()
del r["test_trigger"], r["test_journey"]
f = analyze(r, SPEC, {"sec-dev": True})
assert "dupe the prod pair" in messages(f, "fail"), f
r = roles4()
del r["prod_trigger"], r["prod_journey"]
f = analyze(r, SPEC, {"sec-dev": True})
assert "fail" not in levels(f) and "naming convention" in messages(f, "warn"), f

# --- twins present but not started ---
f = analyze(roles4(test_state="draft"), SPEC, {"sec-dev": True})
assert "start both twin halves" in messages(f, "warn"), f

# --- prod journey draft is informational, never a fail ---
f = analyze(roles4(prod_state="draft"), SPEC, {"sec-dev": True})
assert "fail" not in levels(f) and "draft" in messages(f, "info"), f

# --- secret states: absent secret fails, unverifiable warns, unregistered warns ---
f = analyze(roles4(), SPEC, {"sec-dev": False})
assert "no secret 'sec-dev'" in messages(f, "fail"), f
f = analyze(roles4(), SPEC, {"sec-dev": None})
assert "Cannot verify" in messages(f, "warn"), f
f = analyze(roles4(), {"test_event_name": "pmy_test_shop"}, {})
assert "No test webhook URL" in messages(f, "warn"), f
# a stored URL (the plain-URL model) satisfies the runner requirement
f = analyze(
    roles4(),
    {"test_event_name": "pmy_test_shop", "event_name": "Shop-260715",
     "test_webhook_url": "https://api.customer.io/v1/webhook/abc123"},
    {},
)
assert levels(f) == {"info"}, f

# --- duplicate role names surface ---
r = roles4()
r["test_journey_duplicate_99"] = campaign(99, "[PMY-TEST] [Journey] [2/2] Shop-260715 copy")
f = analyze(r, SPEC, {"sec-dev": True})
assert "duplicate" in messages(f, "warn"), f

# --- entry shape validation ---
assert validate_entry(dict(SPEC)) == []
errs = validate_entry({"test_event_name": "shop_test"})
assert any(TEST_EVENT_PREFIX in e for e in errs), errs
errs = validate_entry({"event_name": "pmy_test_shop"})
assert any("must not use" in e for e in errs), errs
errs = validate_entry({"event_name": "same", "test_event_name": "same"})
assert errs, "identical prod/test events must be rejected"
errs = validate_entry({"payload_fields": ["ok_field", "bad field!"]})
assert any("bad field!" in e for e in errs), errs
errs = validate_entry({"test_webhook_secret": "no spaces allowed"})
assert errs, "secret ids with spaces must be rejected"

# --- pasted webhook URLs: the 500 class — must become a readable explanation ---
URL = "https://api.customer.io/v1/webhook/7598331b7897e66b"
assert secret_ref_problem("cio-trigger-url-shopify-retail-dev") is None
assert "webhook URL itself" in (secret_ref_problem(URL) or ""), secret_ref_problem(URL)
assert "not a valid Secret Manager id" in (secret_ref_problem("bad id!") or "")
errs = validate_entry({"test_webhook_secret": URL})
assert any("Secret Manager" in e for e in errs), errs
errs = validate_entry({"webhook_secrets": [URL]})
assert any("webhook URL itself" in e for e in errs), errs

# --- the plain-URL field: accepts a CIO webhook URL, explains anything else ---
assert webhook_url_problem(URL) is None
assert webhook_url_problem("https://api-eu.customer.io/v1/webhook/abc") is None
assert "doesn't look like a webhook URL" in (webhook_url_problem("cio-trigger-url-shopify-retail-dev") or "")
assert "not a Customer.io webhook URL" in (webhook_url_problem("https://evil.example.com/hook") or "")
assert validate_entry({"test_webhook_url": URL}) == []
errs = validate_entry({"test_webhook_url": "some-secret-id"})
assert any("paste the twin's full trigger URL" in e for e in errs), errs


# --- discovery: registry values suggested from the workspace ---
class StubCio:
    def __init__(self, actions=None, fail=False):
        self._actions = actions or []
        self._fail = fail

    def campaign_actions(self, campaign_id):
        if self._fail:
            raise RuntimeError("CIO down")
        return self._actions


ACTIONS = [
    {"type": "attribute_update", "body": '[{"name": "email"}]'},
    {"type": "create_event", "body": '[{"name": "product"}, {"name": "amount"}]'},
]

s = suggested_entry(roles4(), StubCio(ACTIONS))
assert s["event_name"] == "Shop-260715" and s["test_event_name"] == "pmy_test_shop", s
assert s["payload_fields"] == ["product", "amount"] and s["person_attributes"] == ["email"], s

# twin still on the prod event (fresh dupe) → suggest the rename target, not the bug
s = suggested_entry(roles4(test_event="Shop-260715"), StubCio(ACTIONS))
assert s["test_event_name"] == TEST_EVENT_PREFIX + "Shop-260715", s

# actions fetch failing must not sink the precheck — events still suggested
s = suggested_entry(roles4(), StubCio(fail=True))
assert s["event_name"] == "Shop-260715" and "payload_fields" not in s, s

# no campaigns at all → nothing to suggest, and no crash
assert suggested_entry({}, StubCio(ACTIONS)) == {}


# --- variables panel: template vs registry vs CIO vs email usage ---
from app.slugs import _variables_from  # noqa: E402

TRIGGER_ACTS = [
    {
        "type": "attribute_update",
        "name": "Create or Update Person 1",
        "body": '[{"name": "first_name"}]',
        "recipient": '{"field": "id", "type": "trigger_attribute", "value": "account_id"}',
    },
    {"type": "create_event", "name": "Send Event", "body": '[{"name": "product"}, {"name": "amount"}]'},
]
JOURNEY_ACTS = [
    {
        "type": "email",
        "subject": "Welcome!",
        "body": "Hi {{customer.first_name}}, you bought {{event.product}}",
    }
]
VSPEC = {
    "slug": "Shop-260715",
    "payload_fields": ["product", "amount"],
    "person_attributes": ["first_name"],
    "payload_template": '{"email": "{identity}", "product": "Scarf", "amount": 20}',
}
v = _variables_from(
    VSPEC,
    roles4(),
    {"test_trigger": TRIGGER_ACTS, "test_journey": JOURNEY_ACTS},
)
assert v["template"]["is_custom"] and v["template"]["keys"] == ["email", "product", "amount"], v["template"]
assert v["registry"]["payload_fields"] == ["product", "amount"], v["registry"]
assert len(v["cio"]) == 1 and v["cio"][0]["role"] == "test_trigger", v["cio"]
assert v["cio"][0]["send_event_fields"] == ["product", "amount"], v["cio"]
assert v["cio"][0]["person_attribute_fields"] == ["first_name"], v["cio"]
assert v["cio"][0]["recipient_field"] == "account_id", v["cio"]
liq = {(x["pair"], x["scope"], x["field"]) for x in v["liquid"]}
assert liq == {("test", "customer", "first_name"), ("test", "event", "product")}, liq
assert v["liquid"][0]["emails"] == ["Welcome!"], v["liquid"]

# no template → default signup keys; no actions → cio/liquid empty, no crash
v = _variables_from({"slug": "X"}, {}, {})
assert not v["template"]["is_custom"] and "signup_form_family" in v["template"]["keys"], v["template"]
assert v["cio"] == [] and v["liquid"] == [], v

print("test_slug_registry: all assertions passed")
