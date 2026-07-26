"""Admin operations: invites and portal-role management.

⚠️ The Firebase Auth user store in sdfc-udp-dev is SHARED with the scouting
sandbox app. Every claim write here MERGES with existing claims — the portal
only ever owns the `portal_role` key. Never call set_custom_user_claims with a
bare dict.
"""

import secrets

import firebase_admin
from firebase_admin import auth as fb_auth

from .config import GCP_PROJECT

VALID_ROLES = ("viewer", "operator", "admin")

_app = None


def _ensure_app():
    global _app
    if _app is None:
        try:
            _app = firebase_admin.get_app()
        except ValueError:
            _app = firebase_admin.initialize_app(options={"projectId": GCP_PROJECT})
    return _app


def _merged_claims(user: fb_auth.UserRecord, portal_role: str | None) -> dict:
    claims = dict(user.custom_claims or {})
    if portal_role is None:
        claims.pop("portal_role", None)
    else:
        claims["portal_role"] = portal_role
    return claims


def list_portal_users() -> list[dict]:
    _ensure_app()
    out = []
    for u in fb_auth.list_users().iterate_all():
        claims = u.custom_claims or {}
        out.append(
            {
                "uid": u.uid,
                "email": u.email,
                "portal_role": claims.get("portal_role"),
                "has_other_claims": bool(set(claims) - {"portal_role"}),
                "providers": [p.provider_id for p in u.provider_data],
                "disabled": u.disabled,
            }
        )
    # Portal users first, then the rest of the shared store.
    out.sort(key=lambda r: (r["portal_role"] is None, (r["email"] or "").lower()))
    return out


def invite(email: str, role: str) -> dict:
    if role not in VALID_ROLES:
        raise ValueError(f"role must be one of {VALID_ROLES}")
    _ensure_app()
    created = False
    try:
        user = fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        user = fb_auth.create_user(email=email, password=secrets.token_urlsafe(24))
        created = True
    fb_auth.set_custom_user_claims(user.uid, _merged_claims(user, role))
    # Password-set link doubles as the invite for email/password sign-in.
    # Google-SSO users can ignore it — the role claim is what matters.
    reset_link = fb_auth.generate_password_reset_link(email)
    return {"uid": user.uid, "email": email, "portal_role": role, "created": created, "invite_link": reset_link}


def set_role(uid: str, role: str | None) -> dict:
    if role is not None and role not in VALID_ROLES:
        raise ValueError(f"role must be one of {VALID_ROLES} or null")
    _ensure_app()
    user = fb_auth.get_user(uid)
    fb_auth.set_custom_user_claims(uid, _merged_claims(user, role))
    return {"uid": uid, "email": user.email, "portal_role": role}
