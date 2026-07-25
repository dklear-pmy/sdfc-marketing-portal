"""Firebase ID-token verification + role-claim authorization.

Invite model: users are created by an admin (Admin SDK) and stamped with a
`role` custom claim. A token without a role claim is rejected everywhere, so a
self-registered account has no access even if provider sign-up is left open.
"""

from typing import Literal

import firebase_admin
from fastapi import Depends, HTTPException, Request
from firebase_admin import auth as fb_auth

from .config import AUTH_DISABLED, GCP_PROJECT

Role = Literal["viewer", "operator", "admin"]
_ROLE_RANK: dict[str, int] = {"viewer": 0, "operator": 1, "admin": 2}

_app = None


def _firebase_app():
    global _app
    if _app is None:
        _app = firebase_admin.initialize_app(options={"projectId": GCP_PROJECT})
    return _app


class Principal:
    def __init__(self, uid: str, email: str | None, role: str):
        self.uid = uid
        self.email = email
        self.role = role


def require_role(minimum: Role):
    async def dependency(request: Request) -> Principal:
        if AUTH_DISABLED:
            return Principal(uid="local-dev", email="local@dev", role="admin")

        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = header.removeprefix("Bearer ")
        try:
            _firebase_app()
            decoded = fb_auth.verify_id_token(token)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid token")

        role = decoded.get("role")
        if role not in _ROLE_RANK:
            raise HTTPException(status_code=403, detail="Account has no access role")
        if _ROLE_RANK[role] < _ROLE_RANK[minimum]:
            raise HTTPException(status_code=403, detail=f"Requires {minimum} role")
        return Principal(uid=decoded["uid"], email=decoded.get("email"), role=role)

    return Depends(dependency)
