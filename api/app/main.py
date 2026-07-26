from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import admin, bqstate, runner
from .auth import Principal, require_role, require_scheduler_oidc
from .config import CORS_ORIGINS
from .validator import validate_slug

app = FastAPI(title="SDFC Marketing Ops API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/harness/validate/{slug}")
def harness_validate(slug: str, principal: Principal = require_role("viewer")) -> dict:
    if len(slug) > 120:
        raise HTTPException(status_code=400, detail="Slug too long")
    return validate_slug(slug)


@app.post("/api/harness/run/{slug}")
def harness_start_run(slug: str, principal: Principal = require_role("operator")) -> dict:
    try:
        return runner.start_run(slug, actor=principal.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/harness/runs")
def harness_list_runs(
    q: str | None = None,
    status: str | None = None,
    limit: int = 50,
    principal: Principal = require_role("viewer"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return {"runs": bqstate.list_runs(q=q, status=status, limit=limit)}


@app.get("/api/harness/runs/{run_id}")
def harness_get_run(run_id: str, principal: Principal = require_role("viewer")) -> dict:
    run = bqstate.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Unknown run")
    return run


@app.post("/api/harness/runs/{run_id}/advance")
def harness_advance_run(run_id: str, principal: Principal = require_role("operator")) -> dict:
    try:
        return runner.advance_run(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown run")


@app.post("/api/harness/runs/tick", dependencies=[Depends(require_scheduler_oidc)])
def harness_tick() -> dict:
    return runner.advance_all()


class InviteRequest(BaseModel):
    email: str
    role: str


class RoleRequest(BaseModel):
    role: str | None


@app.get("/api/admin/users")
def admin_list_users(principal: Principal = require_role("admin")) -> dict:
    return {"users": admin.list_portal_users()}


@app.post("/api/admin/invites")
def admin_invite(body: InviteRequest, principal: Principal = require_role("admin")) -> dict:
    if "@" not in body.email or len(body.email) > 254:
        raise HTTPException(status_code=400, detail="Invalid email")
    try:
        return admin.invite(body.email.strip().lower(), body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/admin/users/{uid}/role")
def admin_set_role(uid: str, body: RoleRequest, principal: Principal = require_role("admin")) -> dict:
    if principal.uid == uid and body.role != "admin":
        raise HTTPException(status_code=400, detail="You cannot demote your own admin role")
    try:
        return admin.set_role(uid, body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
