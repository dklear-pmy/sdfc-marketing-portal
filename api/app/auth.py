"""Firebase ID-token verification + role/section-claim authorization.

Invite model: users are created by an admin (Admin SDK) and stamped with a
`portal_role` custom claim. A token without a role claim is rejected
everywhere, so a self-registered account has no access even if provider
sign-up is left open.

Access is two-axis:
- `portal_role` (viewer < operator < admin) — how much a user may DO.
- `portal_sections` — which areas they may SEE. Three sections (marketing /
  fans / stadium) are implied: admins always hold them, and a missing claim
  grants them too, because pre-sections accounts were invited when access was
  all-or-nothing. The `platform` section (Pipeline Spend) is never implied:
  an account holds it only through an explicit grant, and only when its email
  is on one of PLATFORM_DOMAINS.
"""

from typing import Literal

import firebase_admin
from fastapi import Depends, HTTPException, Request
from firebase_admin import auth as fb_auth

from .config import AUTH_DISABLED, GCP_PROJECT, PORTAL_SA_EMAIL, TICK_AUDIENCE

Role = Literal["viewer", "operator", "admin"]
_ROLE_RANK: dict[str, int] = {"viewer": 0, "operator": 1, "admin": 2}

Section = Literal["marketing", "fans", "stadium", "platform"]
SECTIONS: tuple[str, ...] = ("marketing", "fans", "stadium", "platform")
# Held by every admin and by every pre-sections account.
IMPLIED_SECTIONS: tuple[str, ...] = ("marketing", "fans", "stadium")
# Pipeline Spend is an explicit per-account grant, limited to these domains.
PLATFORM_DOMAINS: tuple[str, ...] = ("pmygroup.com", "sandiegofc.com")

_app = None


def _firebase_app():
    global _app
    if _app is None:
        _app = firebase_admin.initialize_app(options={"projectId": GCP_PROJECT})
    return _app


class Principal:
    def __init__(self, uid: str, email: str | None, role: str, sections: frozenset[str]):
        self.uid = uid
        self.email = email
        self.role = role
        self.sections = sections


def platform_allowed(email: str | None) -> bool:
    """Whether this account may hold the platform section at all."""
    if not email or "@" not in email:
        return False
    return email.rsplit("@", 1)[1].lower() in PLATFORM_DOMAINS


def resolve_sections(role: str, claim: object, email: str | None = None) -> frozenset[str]:
    """Sections a token grants.

    Admin or a missing claim ⇒ the implied sections; for a non-admin an
    explicit list is authoritative over the implied sections, with unknown
    keys dropped; any other claim shape grants nothing. `platform` is held
    only when the list names it and the account's domain allows it — never by
    admin rank, never through a missing claim.
    """
    if role == "admin" or claim is None:
        held = set(IMPLIED_SECTIONS)
    elif isinstance(claim, list):
        held = {s for s in claim if s in IMPLIED_SECTIONS}
    else:
        return frozenset()
    if isinstance(claim, list) and "platform" in claim and platform_allowed(email):
        held.add("platform")
    return frozenset(held)


def access_error(role: str, sections: frozenset[str], section: str | None, minimum: str) -> str | None:
    """The 403 detail for this principal/requirement pair, or None if allowed."""
    if _ROLE_RANK[role] < _ROLE_RANK[minimum]:
        return f"Requires {minimum} role"
    if section is not None and section not in sections:
        return f"Account has no access to the {section} section"
    return None


async def require_scheduler_oidc(request: Request) -> None:
    """Authorize the Cloud Scheduler tick: a Google-signed OIDC token minted for
    the portal SA with our fixed audience. Not a Firebase token."""
    if AUTH_DISABLED:
        return
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = header.removeprefix("Bearer ")
    try:
        import google.auth.transport.requests
        from google.oauth2 import id_token as google_id_token

        payload = google_id_token.verify_oauth2_token(
            token, google.auth.transport.requests.Request(), audience=TICK_AUDIENCE
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid OIDC token")
    if not payload.get("email_verified") or payload.get("email") != PORTAL_SA_EMAIL:
        raise HTTPException(status_code=403, detail="Wrong OIDC identity")


async def _authenticate(request: Request) -> Principal:
    if AUTH_DISABLED:
        return Principal(
            uid="local-dev", email="local@dev", role="admin", sections=frozenset(SECTIONS)
        )

    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = header.removeprefix("Bearer ")
    try:
        _firebase_app()
        decoded = fb_auth.verify_id_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    # The Firebase Auth user store in sdfc-udp-dev is SHARED with the
    # scouting sandbox app, whose users carry their own `role` claim
    # (system_admin). The portal therefore namespaces its claims as
    # `portal_role` / `portal_sections` — and any claim write MUST merge with
    # existing claims (set_custom_user_claims replaces the whole dict).
    role = decoded.get("portal_role")
    if role not in _ROLE_RANK:
        raise HTTPException(status_code=403, detail="Account has no access role")
    return Principal(
        uid=decoded["uid"],
        email=decoded.get("email"),
        role=role,
        sections=resolve_sections(role, decoded.get("portal_sections"), decoded.get("email")),
    )


def require_role(minimum: Role):
    """Level check only — for endpoints outside any section (admin surface)."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        error = access_error(principal.role, principal.sections, None, minimum)
        if error:
            raise HTTPException(status_code=403, detail=error)
        return principal

    return Depends(dependency)


def require_access(section: Section, minimum: Role = "viewer"):
    """Level check + section membership. Admins hold the implied sections
    through resolve_sections; `platform` needs an explicit grant even for them."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        error = access_error(principal.role, principal.sections, section, minimum)
        if error:
            raise HTTPException(status_code=403, detail=error)
        return principal

    return Depends(dependency)
