import re

import requests
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import admin, bqstate, customers, emailer, ledger, runner, stadium, tripwires
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


_CIO_ID_RE = re.compile(r"[A-Za-z0-9_=-]{4,64}")
_EVENT_RE = re.compile(r"[A-Za-z0-9 /&'.-]{1,60}")


@app.get("/api/stadium-heat/events")
def stadium_events(principal: Principal = require_role("viewer")) -> dict:
    return stadium.events()


@app.get("/api/stadium-heat")
def stadium_heat(event: str = "next", principal: Principal = require_role("viewer")) -> dict:
    if not _EVENT_RE.fullmatch(event):
        raise HTTPException(status_code=400, detail="Invalid event name")
    try:
        return stadium.heat(event)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _valid_email(email: str) -> str:
    email = email.strip().lower()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="Invalid email")
    return email


@app.get("/api/customers/lookup")
def customers_lookup(email: str, principal: Principal = require_role("viewer")) -> dict:
    try:
        return customers.lookup(_valid_email(email))
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


@app.get("/api/ledger/events")
def ledger_events(
    q: str | None = None,
    activity: str | None = None,
    source: str | None = None,
    window: str = "7d",
    include_echo: bool = False,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_role("viewer"),
) -> dict:
    if window not in ledger.WINDOWS:
        raise HTTPException(status_code=400, detail=f"window must be one of {list(ledger.WINDOWS)}")
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return ledger.events_page(
        q, activity, source, window=window, include_echo=include_echo,
        limit=max(1, min(limit, 100)), offset=max(0, min(offset, 100_000)),
    )


@app.get("/api/ledger/statuses")
def ledger_statuses(
    q: str | None = None,
    domain: str | None = None,
    status: str | None = None,
    latched_only: bool = False,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_role("viewer"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return ledger.statuses_page(
        q, domain, status, latched_only=latched_only,
        limit=max(1, min(limit, 100)), offset=max(0, min(offset, 100_000)),
    )


@app.get("/api/customers/ledger")
def customers_ledger(
    email: str,
    limit: int = 25,
    offset: int = 0,
    principal: Principal = require_role("viewer"),
) -> dict:
    return customers.fan_ledger(
        _valid_email(email), limit=max(1, min(limit, 100)), offset=max(0, min(offset, 100_000))
    )


@app.get("/api/customers/list")
def customers_list(
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_role("viewer"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return customers.list_fans(q, limit=max(1, min(limit, 100)), offset=max(0, min(offset, 100_000)))


@app.get("/api/customers/{cio_id}/activities")
def customers_activities(
    cio_id: str,
    start: str | None = None,
    limit: int = 20,
    principal: Principal = require_role("viewer"),
) -> dict:
    if not _CIO_ID_RE.fullmatch(cio_id):
        raise HTTPException(status_code=400, detail="Invalid cio_id")
    try:
        return customers.activities_page(cio_id, limit=max(1, min(limit, 50)), start=start)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


@app.get("/api/customers/{cio_id}/messages")
def customers_messages(
    cio_id: str,
    start: str | None = None,
    limit: int = 20,
    principal: Principal = require_role("viewer"),
) -> dict:
    if not _CIO_ID_RE.fullmatch(cio_id):
        raise HTTPException(status_code=400, detail="Invalid cio_id")
    try:
        return customers.messages_page(cio_id, limit=max(1, min(limit, 50)), start=start)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


class TripwireCreate(BaseModel):
    email: str
    label: str
    purpose: str | None = None
    expect_subscribed: bool = True
    max_quiet_days: int | None = None
    provision_slug: str | None = None


@app.get("/api/tripwires")
def tripwires_state(principal: Principal = require_role("viewer")) -> dict:
    return tripwires.state()


@app.get("/api/tripwires/history")
def tripwires_history(
    limit: int = 100,
    email: str | None = None,
    principal: Principal = require_role("viewer"),
) -> dict:
    return {"history": tripwires.history(limit=limit, email=email)}


@app.post("/api/tripwires/run")
def tripwires_run(principal: Principal = require_role("operator")) -> dict:
    return tripwires.run_checks(source=principal.email or "manual")


@app.post("/api/tripwires/tick", dependencies=[Depends(require_scheduler_oidc)])
def tripwires_tick() -> dict:
    return tripwires.run_checks(source="scheduler")


@app.post("/api/tripwires")
def tripwires_add(body: TripwireCreate, principal: Principal = require_role("operator")) -> dict:
    if len(body.label) > 60:
        raise HTTPException(status_code=400, detail="Label too long")
    try:
        return tripwires.add_tripwire(
            _valid_email(body.email),
            body.label.strip(),
            (body.purpose or "").strip() or None,
            expect_subscribed=body.expect_subscribed,
            max_quiet_days=body.max_quiet_days,
            provision_slug=body.provision_slug,
            actor=principal.email,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class TripwireUpdate(BaseModel):
    label: str | None = None
    purpose: str | None = None
    expect_subscribed: bool | None = None
    # Explicit sentinel: omitting the key leaves the threshold alone, whereas
    # sending null deliberately DISABLES the quiet check.
    max_quiet_days: int | None = None
    clear_quiet: bool = False
    active: bool | None = None


@app.patch("/api/tripwires/{email}")
def tripwires_update(
    email: str, body: TripwireUpdate, principal: Principal = require_role("operator")
) -> dict:
    if body.label and len(body.label) > 60:
        raise HTTPException(status_code=400, detail="Label too long")
    quiet: object = None if body.clear_quiet else body.max_quiet_days
    if not body.clear_quiet and body.max_quiet_days is None:
        quiet = tripwires._SENTINEL  # leave the threshold untouched
    if isinstance(quiet, int) and quiet < 1:
        raise HTTPException(status_code=400, detail="max_quiet_days must be at least 1")
    try:
        return tripwires.update_tripwire(
            _valid_email(email),
            label=(body.label or "").strip() or None,
            purpose=(body.purpose or "").strip() or None,
            expect_subscribed=body.expect_subscribed,
            max_quiet_days=quiet,
            active=body.active,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/tripwires/canary")
def tripwires_canary(principal: Principal = require_role("operator")) -> dict:
    """Fire the synthetic canary by hand (the hourly Scheduler job posts to
    /api/tripwires/canary/tick)."""
    try:
        return tripwires.send_canary()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/tripwires/canary/tick", dependencies=[Depends(require_scheduler_oidc)])
def tripwires_canary_tick() -> dict:
    return tripwires.send_canary()


class RecipientRequest(BaseModel):
    email: str
    label: str | None = None


@app.get("/api/admin/alert-recipients")
def alert_recipients_list(principal: Principal = require_role("admin")) -> dict:
    rows = emailer.list_recipients()
    return {
        "recipients": rows,
        "fallback": emailer.FALLBACK_RECIPIENT if not rows else None,
    }


@app.post("/api/admin/alert-recipients")
def alert_recipients_add(
    body: RecipientRequest, principal: Principal = require_role("admin")
) -> dict:
    if body.label and len(body.label) > 80:
        raise HTTPException(status_code=400, detail="Label too long")
    return emailer.add_recipient(
        _valid_email(body.email), (body.label or "").strip() or None, principal.email
    )


@app.delete("/api/admin/alert-recipients/{email}")
def alert_recipients_remove(email: str, principal: Principal = require_role("admin")) -> dict:
    return emailer.remove_recipient(_valid_email(email))


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
