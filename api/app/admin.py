"""Admin operations: invites, portal-role and section-grant management.

⚠️ The Firebase Auth user store in sdfc-udp-dev is SHARED with the scouting
sandbox app. Every claim write here MERGES with existing claims — the portal
only ever owns the `portal_role` and `portal_sections` keys. Never call
set_custom_user_claims with a bare dict.
"""

import secrets

import firebase_admin
from firebase_admin import auth as fb_auth

from .config import GCP_PROJECT

VALID_ROLES = ("viewer", "operator", "admin")
VALID_SECTIONS = ("marketing", "fans", "stadium")

_app = None


def _ensure_app():
    global _app
    if _app is None:
        try:
            _app = firebase_admin.get_app()
        except ValueError:
            _app = firebase_admin.initialize_app(options={"projectId": GCP_PROJECT})
    return _app


def merged_claims(
    existing: dict | None,
    portal_role: str | None,
    portal_sections: list[str] | None,
) -> dict:
    """Next full claims dict, touching only the portal-owned keys.

    - portal_role None ⇒ full revoke: both portal keys removed.
    - portal_sections None with a role ⇒ sections left as they are (callers
      that only change the role must not silently rewrite grants).
    - portal_sections list ⇒ validated, deduped, stored in canonical order.
      An empty list is legitimate: role but no sections yet.
    """
    claims = dict(existing or {})
    if portal_role is None:
        claims.pop("portal_role", None)
        claims.pop("portal_sections", None)
        return claims
    claims["portal_role"] = portal_role
    if portal_sections is not None:
        bad = [s for s in portal_sections if s not in VALID_SECTIONS]
        if bad:
            raise ValueError(f"Unknown sections {bad}; valid: {list(VALID_SECTIONS)}")
        claims["portal_sections"] = [s for s in VALID_SECTIONS if s in portal_sections]
    return claims


def list_portal_users() -> list[dict]:
    """ONLY accounts holding a portal_role. The shared store's other tenants
    (and their existence) are never exposed through this API — granting access
    to an unlisted account goes through invite(), which role-stamps an
    existing user in place."""
    _ensure_app()
    out = []
    for u in fb_auth.list_users().iterate_all():
        claims = u.custom_claims or {}
        role = claims.get("portal_role")
        if role is None:
            continue
        out.append(
            {
                "uid": u.uid,
                "email": u.email,
                "portal_role": role,
                # None = pre-sections account (legacy full access) — distinct
                # from [] (explicitly no sections).
                "portal_sections": claims.get("portal_sections"),
                "providers": [p.provider_id for p in u.provider_data],
                "disabled": u.disabled,
            }
        )
    out.sort(key=lambda r: (r["email"] or "").lower())
    return out


def invite(email: str, role: str, sections: list[str] | None = None) -> dict:
    if role not in VALID_ROLES:
        raise ValueError(f"role must be one of {VALID_ROLES}")
    _ensure_app()
    created = False
    try:
        user = fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        user = fb_auth.create_user(email=email, password=secrets.token_urlsafe(24))
        created = True
    claims = merged_claims(user.custom_claims, role, sections)
    fb_auth.set_custom_user_claims(user.uid, claims)
    # Password-set link doubles as the invite for email/password sign-in.
    # Google-SSO users can ignore it — the role claim is what matters.
    reset_link = fb_auth.generate_password_reset_link(email)
    return {
        "uid": user.uid,
        "email": email,
        "portal_role": role,
        "portal_sections": claims.get("portal_sections"),
        "created": created,
        "invite_link": reset_link,
    }


def set_role(uid: str, role: str | None, sections: list[str] | None = None) -> dict:
    if role is not None and role not in VALID_ROLES:
        raise ValueError(f"role must be one of {VALID_ROLES} or null")
    _ensure_app()
    user = fb_auth.get_user(uid)
    claims = merged_claims(user.custom_claims, role, sections)
    fb_auth.set_custom_user_claims(uid, claims)
    return {
        "uid": uid,
        "email": user.email,
        "portal_role": role,
        "portal_sections": claims.get("portal_sections"),
    }
