"""Pure tests for the shadow-run safety guards — the layers that make
real-data test fires unable to reach a real person or touch a real profile.
No credentials, no network."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.shadow import (  # noqa: E402
    IDENTITY_KEYS,
    SHADOW_ID_PREFIX,
    SINK_DOMAIN,
    ShadowGuardError,
    assert_sink_only,
    sanitize_payload,
    shadow_identity,
)

# A realistic supporters candidate row — real person, real rep, real ids.
REAL_ROW = {
    "dedup_key": "006UR00000AbCdEfGH",
    "email": "Jane.Doe@gmail.com",
    "first_name": "Jane",
    "last_name": "Doe",
    "account_name": "Jane Doe Household",
    "account_id": "001UR00000XyZzYxWV",
    "opportunity_id": "006UR00000AbCdEfGH",
    "opportunity_name": "Jane Doe Household 2026 Ticket Sales",
    "stage_name": "Closed Won",
    "is_closed": True,
    "is_won": True,
    "product": "General Season Membership",
    "amount": 2468.0,
    "seat_block": "Section 118, Row 12, Seats 1-2",
    "number_of_seats": 2,
    "ticket_price": 617.0,
    "close_date": "2026-07-17",
    "rep_name": "Ryan Rep",
    "rep_email": "ryan.rep@sandiegofc.com",
    "rep_phone": "+1 619 555 0100",
    "account_owner": "Ryan Rep",
    "ticketing_event_date": 1786327200,
    "ticketing_event_name": "2026 Leagues Cup Phase One: San Diego FC vs. Club Tijuana",
}

# ---- shadow_identity ---------------------------------------------------------

ident = shadow_identity("Jane.Doe@gmail.com", "run-1")
assert ident.endswith("@" + SINK_DOMAIN), ident
assert ident.startswith("shadow."), ident
assert "jane-doe" in ident and "gmail" in ident, f"stay recognizable: {ident}"
# Unique per run, stable within one.
assert shadow_identity("Jane.Doe@gmail.com", "run-1") == ident
assert shadow_identity("Jane.Doe@gmail.com", "run-2") != ident
# Local part obeys the 64-char SMTP limit even for absurd inputs.
long = shadow_identity("x" * 200 + "@" + "y" * 100 + ".com", "run-1")
assert len(long.split("@")[0]) <= 64, long
assert long.endswith("@" + SINK_DOMAIN)

# ---- sanitize_payload --------------------------------------------------------

clean, identity = sanitize_payload(dict(REAL_ROW), nonce="run-abc")

# The recipient email is the shadow identity, on the sink.
assert clean["email"] == identity
assert identity.endswith("@" + SINK_DOMAIN)

# Every profile-identity key is prefixed — a shadow fire must never resolve
# to (and rewrite!) the real fan's CIO profile, which the People sync keys
# on the SF account id.
assert clean["account_id"] == SHADOW_ID_PREFIX + REAL_ROW["account_id"]
assert "account_id" in IDENTITY_KEYS

# Non-identity ids stay real — that's the point of real-data runs.
assert clean["opportunity_id"] == REAL_ROW["opportunity_id"]
assert clean["dedup_key"] == REAL_ROW["dedup_key"]

# Other email-shaped values move to the sink domain, keeping their local part.
assert clean["rep_email"] == "ryan.rep@" + SINK_DOMAIN

# Real content is preserved — names, amounts, seats.
assert clean["first_name"] == "Jane" and clean["seat_block"] == REAL_ROW["seat_block"]
assert clean["amount"] == 2468.0 and clean["is_won"] is True

# The original address appears NOWHERE in the outgoing bytes.
import json  # noqa: E402

serialized = json.dumps(clean).lower()
assert "jane.doe@gmail.com" not in serialized
assert "@gmail.com" not in serialized
assert "@sandiegofc.com" not in serialized

# Nested structures are walked too.
nested = {"email": "a@b.com", "meta": {"contact": "real.person@yahoo.com", "ids": [{"account_id": "001X"}]}}
clean2, _ = sanitize_payload(nested, nonce="n")
assert clean2["meta"]["contact"] == "real.person@" + SINK_DOMAIN
assert clean2["meta"]["ids"][0]["account_id"] == SHADOW_ID_PREFIX + "001X"

# A row with no usable email refuses loudly.
try:
    sanitize_payload({"first_name": "X"}, nonce="n")
    raise AssertionError("expected ShadowGuardError for missing email")
except ShadowGuardError:
    pass

# ---- assert_sink_only (the independent second layer) -------------------------

assert_sink_only(clean)  # sanitized output passes

for bad in (
    {"email": "ok@qa.sdfc.dev", "note": "reach me at real@gmail.com"},
    {"email": "Real.Person@Gmail.Com"},
    {"deep": {"list": [{"x": "cc: someone@corp.example"}]}},
):
    try:
        assert_sink_only(bad)
        raise AssertionError(f"expected refusal for {bad}")
    except ShadowGuardError:
        pass

# Case-insensitive sink match: an uppercased sink address is still safe.
assert_sink_only({"email": "Shadow.Someone@QA.SDFC.DEV"})

print("shadow guards: all assertions passed")
