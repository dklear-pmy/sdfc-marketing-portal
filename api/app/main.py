import json
import re

import requests
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import admin, affected, bqstate, customers, emailer, ledger, payloads, runner, slugs, stadium, tripwires
from .auth import Principal, require_access, require_role, require_scheduler_oidc
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


def _valid_slug(slug: str) -> str:
    slug = slug.strip()
    if not slugs.SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Invalid slug format")
    return slug


class SlugUpsert(BaseModel):
    trigger_key: str | None = None
    trigger_label: str | None = None
    event_name: str | None = None
    test_event_name: str | None = None
    payload_fields: list[str] = []
    person_attributes: list[str] = []
    filter_fields: list[str] = []
    webhook_secrets: list[str] = []
    test_webhook_secret: str | None = None
    test_webhook_url: str | None = None
    payload_template: str | None = None
    notes: str | None = None


@app.get("/api/slugs")
def slugs_list(q: str | None = None, principal: Principal = require_access("marketing")) -> dict:
    if q and len(q) > 120:
        raise HTTPException(status_code=400, detail="Search too long")
    return {
        "slugs": slugs.list_slugs(q=q),
        "default_payload_template": json.dumps(payloads.DEFAULT_TEMPLATE, indent=2),
        "payload_tokens": payloads.TOKEN_DOC,
    }


@app.get("/api/slugs/{slug}/precheck")
def slugs_precheck(
    slug: str,
    event_name: str | None = None,
    test_event_name: str | None = None,
    test_webhook_url: str | None = None,
    payload_template: str | None = None,
    principal: Principal = require_access("marketing"),
) -> dict:
    if payload_template and len(payload_template) > 10_000:
        raise HTTPException(status_code=400, detail="Payload template too long")
    try:
        return slugs.precheck(
            _valid_slug(slug),
            overrides={
                "event_name": event_name,
                "test_event_name": test_event_name,
                "test_webhook_url": test_webhook_url,
                "payload_template": payload_template,
            },
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


@app.get("/api/slugs/{slug}/variables")
def slugs_variables(slug: str, principal: Principal = require_access("marketing")) -> dict:
    try:
        return slugs.variables_report(_valid_slug(slug))
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


@app.post("/api/slugs/{slug}/variables/refresh")
def slugs_variables_refresh(slug: str, principal: Principal = require_access("marketing", "operator")) -> dict:
    try:
        return slugs.refresh_variables(_valid_slug(slug), actor=principal.email)
    except KeyError:
        raise HTTPException(status_code=404, detail="Slug not registered")
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Customer.io API error: {e}")


@app.get("/api/slugs/{slug}/affected")
def slugs_affected(
    slug: str,
    q: str | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_access("marketing"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    page = affected.affected_page(
        _valid_slug(slug),
        q,
        status,
        limit=max(1, min(limit, 100)),
        offset=max(0, min(offset, 100_000)),
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    return page


@app.get("/api/slugs/{slug}/preview")
def slugs_preview(
    slug: str,
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_access("marketing"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    page = affected.would_fire_page(
        _valid_slug(slug),
        q,
        limit=max(1, min(limit, 100)),
        offset=max(0, min(offset, 100_000)),
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    return page


@app.post("/api/slugs/{slug}/sample")
def slugs_send_sample(
    slug: str,
    target: str = "test",
    force: bool = False,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    if target not in ("test", "prod"):
        raise HTTPException(status_code=400, detail="target must be 'test' or 'prod'")
    result = runner.send_sample(_valid_slug(slug), target, force=force)
    if result is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    if result.get("blocked"):
        raise HTTPException(status_code=409, detail=result["error"])
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.get("/api/slugs/{slug}")
def slugs_get(slug: str, principal: Principal = require_access("marketing")) -> dict:
    entry = slugs.get_slug(_valid_slug(slug))
    if entry is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    return entry


@app.put("/api/slugs/{slug}")
def slugs_upsert(
    slug: str, body: SlugUpsert, principal: Principal = require_access("marketing", "operator")
) -> dict:
    fields = body.model_dump()
    if body.notes and len(body.notes) > 2000:
        raise HTTPException(status_code=400, detail="Notes too long")
    errors = slugs.validate_entry(fields)
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))
    return slugs.upsert_slug(_valid_slug(slug), fields, actor=principal.email)


@app.delete("/api/slugs/{slug}")
def slugs_delete(slug: str, principal: Principal = require_access("marketing", "operator")) -> dict:
    if not slugs.delete_slug(_valid_slug(slug)):
        raise HTTPException(status_code=404, detail="Slug not registered")
    return {"deleted": slug}


@app.get("/api/harness/validate/{slug}")
def harness_validate(slug: str, principal: Principal = require_access("marketing")) -> dict:
    if len(slug) > 120:
        raise HTTPException(status_code=400, detail="Slug too long")
    return validate_slug(slug)


@app.post("/api/harness/run/{slug}")
def harness_start_run(slug: str, principal: Principal = require_access("marketing", "operator")) -> dict:
    try:
        return runner.start_run(slug, actor=principal.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/harness/runs")
def harness_list_runs(
    q: str | None = None,
    status: str | None = None,
    limit: int = 50,
    principal: Principal = require_access("marketing"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return {"runs": bqstate.list_runs(q=q, status=status, limit=limit)}


@app.get("/api/harness/runs/{run_id}")
def harness_get_run(run_id: str, principal: Principal = require_access("marketing")) -> dict:
    run = bqstate.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Unknown run")
    return run


@app.post("/api/harness/runs/{run_id}/advance")
def harness_advance_run(run_id: str, principal: Principal = require_access("marketing", "operator")) -> dict:
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
def stadium_events(principal: Principal = require_access("stadium")) -> dict:
    return stadium.events()


@app.get("/api/stadium-heat")
def stadium_heat(event: str = "next", principal: Principal = require_access("stadium")) -> dict:
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
def customers_lookup(email: str, principal: Principal = require_access("fans")) -> dict:
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
    principal: Principal = require_access("fans"),
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
    principal: Principal = require_access("fans"),
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
    q: str | None = None,
    principal: Principal = require_access("fans"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return customers.fan_ledger(
        _valid_email(email),
        limit=max(1, min(limit, 100)),
        offset=max(0, min(offset, 100_000)),
        q=q,
    )


@app.get("/api/customers/list")
def customers_list(
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    principal: Principal = require_access("fans"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return customers.list_fans(q, limit=max(1, min(limit, 100)), offset=max(0, min(offset, 100_000)))


@app.get("/api/customers/{cio_id}/activities")
def customers_activities(
    cio_id: str,
    start: str | None = None,
    limit: int = 20,
    principal: Principal = require_access("fans"),
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
    principal: Principal = require_access("fans"),
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
def tripwires_state(principal: Principal = require_access("marketing")) -> dict:
    return tripwires.state()


@app.get("/api/tripwires/history")
def tripwires_history(
    limit: int = 100,
    email: str | None = None,
    principal: Principal = require_access("marketing"),
) -> dict:
    return {"history": tripwires.history(limit=limit, email=email)}


@app.post("/api/tripwires/run")
def tripwires_run(principal: Principal = require_access("marketing", "operator")) -> dict:
    return tripwires.run_checks(source=principal.email or "manual")


@app.post("/api/tripwires/tick", dependencies=[Depends(require_scheduler_oidc)])
def tripwires_tick() -> dict:
    return tripwires.run_checks(source="scheduler")


@app.post("/api/tripwires")
def tripwires_add(body: TripwireCreate, principal: Principal = require_access("marketing", "operator")) -> dict:
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
    email: str, body: TripwireUpdate, principal: Principal = require_access("marketing", "operator")
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


@app.post("/api/tripwires/{email}/unsubscribe")
def tripwires_make_resub_guard(
    email: str, principal: Principal = require_access("marketing", "operator")
) -> dict:
    """Unsubscribe a tripwire through its own email's one-click link and flip
    its expectation — from then on the 5-minute checks alert on re-subscription."""
    try:
        return tripwires.make_resub_guard(_valid_email(email))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/tripwires/{email}")
def tripwires_delete(email: str, principal: Principal = require_access("marketing", "operator")) -> dict:
    """Soft delete — checks stop and the card is hidden; CIO profile and check
    history stay, and the tripwire can be restored."""
    try:
        return tripwires.delete_tripwire(_valid_email(email))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/tripwires/{email}/restore")
def tripwires_restore(email: str, principal: Principal = require_access("marketing", "operator")) -> dict:
    try:
        return tripwires.restore_tripwire(_valid_email(email))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/tripwires/canary")
def tripwires_canary(principal: Principal = require_access("marketing", "operator")) -> dict:
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
    # None = leave grants alone (existing user) / legacy full access (new user).
    sections: list[str] | None = None


class RoleRequest(BaseModel):
    role: str | None
    # None = leave grants unchanged; a list (even []) is authoritative.
    sections: list[str] | None = None


@app.get("/api/admin/users")
def admin_list_users(principal: Principal = require_role("admin")) -> dict:
    return {"users": admin.list_portal_users()}


@app.post("/api/admin/invites")
def admin_invite(body: InviteRequest, principal: Principal = require_role("admin")) -> dict:
    if "@" not in body.email or len(body.email) > 254:
        raise HTTPException(status_code=400, detail="Invalid email")
    try:
        return admin.invite(body.email.strip().lower(), body.role, body.sections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/admin/users/{uid}/role")
def admin_set_role(uid: str, body: RoleRequest, principal: Principal = require_role("admin")) -> dict:
    if principal.uid == uid and body.role != "admin":
        raise HTTPException(status_code=400, detail="You cannot demote your own admin role")
    try:
        return admin.set_role(uid, body.role, body.sections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
