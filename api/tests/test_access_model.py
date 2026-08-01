"""Pure tests for the two-axis access model: section resolution, the
access-decision helper, and merge-only claim construction. No credentials,
no Firebase — safe for CI."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.admin import merged_claims  # noqa: E402
from app.auth import SECTIONS, access_error, resolve_sections  # noqa: E402

# ---- resolve_sections -------------------------------------------------------

# Admin holds every section no matter what the claim says.
assert resolve_sections("admin", None) == frozenset(SECTIONS)
assert resolve_sections("admin", []) == frozenset(SECTIONS)
assert resolve_sections("admin", ["fans"]) == frozenset(SECTIONS)

# Missing claim = pre-sections account = legacy full access.
assert resolve_sections("viewer", None) == frozenset(SECTIONS)
assert resolve_sections("operator", None) == frozenset(SECTIONS)

# An explicit list is authoritative; [] means no sections.
assert resolve_sections("viewer", []) == frozenset()
assert resolve_sections("operator", ["marketing"]) == frozenset({"marketing"})
assert resolve_sections("viewer", ["fans", "stadium"]) == frozenset({"fans", "stadium"})

# Unknown keys dropped (forward compat); junk claim shapes grant nothing.
assert resolve_sections("viewer", ["fans", "payroll"]) == frozenset({"fans"})
assert resolve_sections("viewer", "fans") == frozenset()
assert resolve_sections("viewer", {"fans": True}) == frozenset()

# ---- access_error -----------------------------------------------------------

ALL = frozenset(SECTIONS)

# Level ranking still applies exactly as before.
assert access_error("viewer", ALL, None, "viewer") is None
assert access_error("viewer", ALL, None, "operator") == "Requires operator role"
assert access_error("operator", ALL, None, "admin") == "Requires admin role"
assert access_error("admin", ALL, None, "admin") is None

# Section membership is enforced for non-admins…
assert access_error("viewer", frozenset({"fans"}), "fans", "viewer") is None
assert (
    access_error("viewer", frozenset({"fans"}), "marketing", "viewer")
    == "Account has no access to the marketing section"
)
assert access_error("operator", frozenset(), "stadium", "viewer") is not None

# …level check wins when both would fail (clearer message for the user)…
assert access_error("viewer", frozenset(), "marketing", "operator") == "Requires operator role"

# …and admins bypass the section check entirely.
assert access_error("admin", frozenset(), "marketing", "viewer") is None

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

print("access model: all assertions passed")
