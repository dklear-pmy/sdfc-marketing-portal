"""Pure tests for the two-axis access model: section resolution, the
access-decision helper, and merge-only claim construction. No credentials,
no Firebase — safe for CI."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.admin import merged_claims  # noqa: E402
from app.auth import IMPLIED_SECTIONS, SECTIONS, access_error, platform_allowed, resolve_sections  # noqa: E402

# ---- resolve_sections -------------------------------------------------------

IMPLIED = frozenset(IMPLIED_SECTIONS)
PMY = "someone@pmygroup.com"
SDFC = "someone@sandiegofc.com"
OTHER = "someone@gmail.com"

# Admin holds the implied sections no matter what the claim says — but never
# platform by rank alone.
assert resolve_sections("admin", None, PMY) == IMPLIED
assert resolve_sections("admin", [], PMY) == IMPLIED
assert resolve_sections("admin", ["fans"], PMY) == IMPLIED
assert "platform" not in resolve_sections("admin", None, PMY)

# Missing claim = pre-sections account = the implied sections, nothing more.
assert resolve_sections("viewer", None, PMY) == IMPLIED
assert resolve_sections("operator", None, SDFC) == IMPLIED

# An explicit list is authoritative; [] means no sections.
assert resolve_sections("viewer", [], PMY) == frozenset()
assert resolve_sections("operator", ["marketing"], PMY) == frozenset({"marketing"})
assert resolve_sections("viewer", ["fans", "stadium"], SDFC) == frozenset({"fans", "stadium"})

# Platform (Pipeline Spend) is an explicit grant, for admins too…
assert resolve_sections("operator", ["platform"], SDFC) == frozenset({"platform"})
assert resolve_sections("admin", ["platform"], PMY) == IMPLIED | {"platform"}
assert resolve_sections("viewer", ["fans", "platform"], PMY) == frozenset({"fans", "platform"})
# …and only for accounts on an allowed domain (case-insensitive).
assert resolve_sections("operator", ["platform"], OTHER) == frozenset()
assert resolve_sections("admin", ["platform"], OTHER) == IMPLIED
assert resolve_sections("operator", ["platform"], None) == frozenset()
assert resolve_sections("operator", ["platform"], "Someone@PMYGroup.com") == frozenset({"platform"})
assert platform_allowed(PMY) and platform_allowed(SDFC)
assert not platform_allowed(OTHER) and not platform_allowed("") and not platform_allowed(None)
assert not platform_allowed("pmygroup.com")

# Unknown keys dropped (forward compat); junk claim shapes grant nothing.
assert resolve_sections("viewer", ["fans", "payroll"], PMY) == frozenset({"fans"})
assert resolve_sections("viewer", "fans", PMY) == frozenset()
assert resolve_sections("viewer", {"fans": True}, PMY) == frozenset()
assert resolve_sections("admin", {"platform": True}, PMY) == IMPLIED

# ---- access_error -----------------------------------------------------------

ALL = frozenset(SECTIONS)

# Level ranking still applies exactly as before.
assert access_error("viewer", ALL, None, "viewer") is None
assert access_error("viewer", ALL, None, "operator") == "Requires operator role"
assert access_error("operator", ALL, None, "admin") == "Requires admin role"
assert access_error("admin", ALL, None, "admin") is None

# Section membership is enforced for everyone, admins included: their implied
# sections come from resolve_sections, not from a bypass here.
assert access_error("viewer", frozenset({"fans"}), "fans", "viewer") is None
assert (
    access_error("viewer", frozenset({"fans"}), "marketing", "viewer")
    == "Account has no access to the marketing section"
)
assert access_error("operator", frozenset(), "stadium", "viewer") is not None
assert access_error("admin", IMPLIED, "marketing", "viewer") is None
assert (
    access_error("admin", IMPLIED, "platform", "admin")
    == "Account has no access to the platform section"
)
assert access_error("admin", IMPLIED | {"platform"}, "platform", "admin") is None

# Level check wins when both would fail (clearer message for the user).
assert access_error("viewer", frozenset(), "marketing", "operator") == "Requires operator role"

# No-section endpoints (admin surface) ignore sections.
assert access_error("viewer", frozenset(), None, "viewer") is None

# ---- merged_claims ----------------------------------------------------------

# Foreign claims from the shared auth store must survive every write.
scouting = {"role": "system_admin", "organizationId": "WUZEXXJxa4RAQ9AALEUO"}

c = merged_claims(scouting, "viewer", ["fans"])
assert c["role"] == "system_admin" and c["organizationId"] == "WUZEXXJxa4RAQ9AALEUO"
assert c["portal_role"] == "viewer" and c["portal_sections"] == ["fans"]

# Full revoke removes both portal keys, nothing else.
c = merged_claims({**scouting, "portal_role": "admin", "portal_sections": ["fans"]}, None, None)
assert "portal_role" not in c and "portal_sections" not in c
assert c["role"] == "system_admin"

# sections=None leaves existing grants untouched (role-only change).
c = merged_claims({"portal_role": "viewer", "portal_sections": ["stadium"]}, "operator", None)
assert c["portal_role"] == "operator" and c["portal_sections"] == ["stadium"]

# A pre-sections account changing role stays pre-sections (legacy full access).
c = merged_claims({"portal_role": "viewer"}, "operator", None)
assert "portal_sections" not in c

# Sections are stored deduped in canonical order; [] is a legitimate value.
c = merged_claims(None, "viewer", ["stadium", "marketing", "stadium"])
assert c["portal_sections"] == ["marketing", "stadium"]
assert merged_claims(None, "viewer", [])["portal_sections"] == []

# Unknown section names are rejected loudly, not dropped silently.
try:
    merged_claims(None, "viewer", ["fans", "payroll"])
    raise AssertionError("expected ValueError for unknown section")
except ValueError as e:
    assert "payroll" in str(e)

# Pipeline Spend is stored only for accounts on an allowed domain; the write
# fails loudly for anyone else, and the other sections are untouched by that.
assert merged_claims(None, "operator", ["platform"], SDFC)["portal_sections"] == ["platform"]
assert merged_claims(scouting, "admin", ["platform"], PMY)["portal_sections"] == ["platform"]
for bad_email in (OTHER, None, ""):
    try:
        merged_claims(None, "viewer", ["fans", "platform"], bad_email)
        raise AssertionError("expected ValueError for platform on a non-allowed domain")
    except ValueError as e:
        assert "Pipeline Spend" in str(e)
assert merged_claims(None, "viewer", ["fans"], OTHER)["portal_sections"] == ["fans"]

print("access model: all assertions passed")
