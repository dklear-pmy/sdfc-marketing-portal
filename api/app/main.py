import json
import re

import requests
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import admin, affected, bqstate, customers, emailer, export_xlsx, ledger, payloads, runner, shadow, slugs, stadium, tripwires
from . import config
from .auth import Principal, require_access, require_role, require_scheduler_oidc
from .config import CORS_ORIGINS
from .validator import validate_slug

app = FastAPI(title="SDFC Marketing Ops API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
    # The Excel export's filename rides Content-Disposition; without exposing
    # it the browser client can read the blob but not the name.
    expose_headers=["Content-Disposition"],
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
    # Editable display name; the slug stays the stable key. Falls back to a
    # prettified slug when unset.
    display_name: str | None = None
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
    # Declared because the registry stores it and the editor sends it — an
    # undeclared field is dropped by Pydantic and then written back as NULL.
    prod_webhook_url: str | None = None
    payload_template: str | None = None
    notes: str | None = None


class NotesUpdate(BaseModel):
    notes: str | None = None


class SampleSendBody(BaseModel):
    """Optional hand-edited demo payload; tokens like {identity} still fill
    server-side, and every email-shaped value is re-checked as owned."""

    payload: dict | None = None


@app.get("/api/slugs")
def slugs_list(q: str | None = None, principal: Principal = require_access("marketing")) -> dict:
    if q and len(q) > 120:
        raise HTTPException(status_code=400, detail="Search too long")
    return {
        "slugs": slugs.list_slugs(q=q),
        "default_payload_template": json.dumps(payloads.DEFAULT_TEMPLATE, indent=2),
        "payload_tokens": payloads.TOKEN_DOC,
    }


@app.get("/api/triggers")
def triggers_list(principal: Principal = require_access("marketing")) -> dict:
    return affected.triggers_overview()


class TriggerLabelUpdate(BaseModel):
    label: str | None = None


class TriggerKillUpdate(BaseModel):
    killed: bool
    reason: str | None = None


@app.post("/api/triggers/{key}/kill")
def triggers_set_kill(
    key: str,
    body: TriggerKillUpdate,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    """Emergency kill switch. Off-only on the hub side (a row can stop a
    trigger, never start one), so killing is operator-level; LIFTING one
    re-allows sends and is admin-only."""
    if not re.fullmatch(r"[a-z0-9_]{1,80}", key):
        raise HTTPException(status_code=400, detail="Bad trigger key")
    if key != affected.KILL_ALL_KEY and key not in affected.TRIGGER_ENABLED:
        raise HTTPException(status_code=404, detail="No such trigger in the hub")
    if not body.killed and principal.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Lifting an emergency disable re-allows sends — admin only",
        )
    reason = (body.reason or "").strip()
    if len(reason) > 300:
        raise HTTPException(status_code=400, detail="Reason is longer than 300 characters")
    affected.set_trigger_kill(key, body.killed, reason or None, actor=principal.email or "?")
    return {"trigger_key": key, "killed": body.killed}


@app.post("/api/triggers/{key}/label")
def triggers_set_label(
    key: str,
    body: TriggerLabelUpdate,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    if not re.fullmatch(r"[a-z0-9_]{1,80}", key):
        raise HTTPException(status_code=400, detail="Bad trigger key")
    label = (body.label or "").strip()
    if len(label) > 80:
        raise HTTPException(status_code=400, detail="Display name is longer than 80 characters")
    updated = affected.set_trigger_label(key, label or None, actor=principal.email)
    if updated == 0:
        raise HTTPException(
            status_code=404,
            detail="No registered campaign carries this trigger key — the label lives on the "
            "campaign registration, so register one first",
        )
    return {"trigger_key": key, "label": label or None, "updated": updated}


@app.get("/api/triggers/{key}/preview")
def triggers_preview(
    key: str,
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    days: int | None = None,
    principal: Principal = require_access("marketing"),
) -> dict:
    if not re.fullmatch(r"[a-z0-9_]{1,80}", key):
        raise HTTPException(status_code=400, detail="Bad trigger key")
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return affected.trigger_preview_page(
        key,
        q,
        days=max(1, min(days, 365)) if days else None,
        limit=max(1, min(limit, 100)),
        offset=max(0, min(offset, 100_000)),
    )


def _preview_export_response(
    trigger_key: str,
    days: int | None,
    q: str | None,
    windows: str | None = None,
    slug: str | None = None,
) -> Response:
    """One .xlsx of the preview. windows="all" puts BOTH windows in one file
    as worksheet tabs (Next Run / Last N days, days defaulting to 90);
    otherwise it's the single window days selects (next-run or last-N-days).
    The filename leads with the campaign slug — the same name the portal URL
    carries — falling back to the trigger key for campaign-less triggers."""
    base = slug or affected.slug_for_trigger(trigger_key)
    if windows == "all":
        filename, data = export_xlsx.campaign_xlsx(
            trigger_key, history_days=max(1, min(days or 90, 365)), q=q, filename_base=base
        )
    else:
        if days and trigger_key not in affected.HISTORY_TRIGGERS:
            raise HTTPException(status_code=400, detail="No history view for this trigger")
        filename, data = export_xlsx.preview_xlsx(
            trigger_key, days=max(1, min(days, 365)) if days else None, q=q, filename_base=base
        )
    return Response(
        content=data,
        media_type=export_xlsx.XLSX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/triggers/{key}/preview/export")
def triggers_preview_export(
    key: str,
    q: str | None = None,
    days: int | None = None,
    windows: str | None = None,
    principal: Principal = require_access("marketing"),
) -> Response:
    if not re.fullmatch(r"[a-z0-9_]{1,80}", key):
        raise HTTPException(status_code=400, detail="Bad trigger key")
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    return _preview_export_response(key, days, q, windows)


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
    days: int | None = None,
    principal: Principal = require_access("marketing"),
) -> dict:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    page = affected.would_fire_page(
        _valid_slug(slug),
        q,
        days=max(1, min(days, 365)) if days else None,
        limit=max(1, min(limit, 100)),
        offset=max(0, min(offset, 100_000)),
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    return page


@app.get("/api/slugs/{slug}/preview/export")
def slugs_preview_export(
    slug: str,
    q: str | None = None,
    days: int | None = None,
    windows: str | None = None,
    principal: Principal = require_access("marketing"),
) -> Response:
    if q and len(q) > 200:
        raise HTTPException(status_code=400, detail="Search too long")
    entry = affected.get_slug(_valid_slug(slug))
    if entry is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    trigger_key = entry.get("trigger_key")
    if not trigger_key:
        raise HTTPException(status_code=400, detail="No trigger key registered for this campaign")
    return _preview_export_response(trigger_key, days, q, windows, slug=entry["slug"])


@app.post("/api/slugs/{slug}/sample")
def slugs_send_sample(
    slug: str,
    target: str = "test",
    force: bool = False,
    recipient: str | None = None,
    body: SampleSendBody | None = None,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    if target not in ("test", "prod"):
        raise HTTPException(status_code=400, detail="target must be 'test' or 'prod'")
    if recipient and len(recipient) > 254:
        raise HTTPException(status_code=400, detail="Recipient is too long")
    payload_override = body.payload if body else None
    if payload_override is not None and len(json.dumps(payload_override)) > 20_000:
        raise HTTPException(status_code=400, detail="Edited payload is too large")
    result = runner.send_sample(
        _valid_slug(slug), target, force=force, recipient=recipient,
        payload_override=payload_override,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Slug not registered")
    if result.get("blocked"):
        raise HTTPException(status_code=409, detail=result["error"])
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    # Sample sends are outward-facing (a real POST at a CIO webhook) — audit
    # every one to stdout, which Cloud Run keeps in Cloud Logging.
    print(json.dumps({
        "audit": "sample_send",
        "actor": principal.email,
        "slug": slug,
        "target": target,
        "mode": result.get("mode"),
        "identity": result.get("identity"),
        "status_code": result.get("status_code"),
        "forced": force,
        "edited": payload_override is not None,
    }))
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
    errors = slugs.validate_entry(fields, slug=slug)
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))
    return slugs.upsert_slug(_valid_slug(slug), fields, actor=principal.email)


@app.patch("/api/slugs/{slug}/notes")
def slugs_update_notes(
    slug: str, body: NotesUpdate, principal: Principal = require_access("marketing", "operator")
) -> dict:
    notes = (body.notes or "").strip() or None
    if notes and len(notes) > 2000:
        raise HTTPException(status_code=400, detail="Notes too long")
    entry = slugs.update_notes(_valid_slug(slug), notes, actor=principal.email)
    if entry is None:
        raise HTTPException(status_code=404, detail="Campaign not registered")
    return entry


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
    result = runner.advance_all()
    # Shadow-armed slugs: fire real-data runs for new live candidates.
    result["shadow"] = shadow.shadow_tick()
    return result


class ReplayRequest(BaseModel):
    limit: int = 10
    history_days: int = 180


@app.get("/api/harness/replay/{slug}/preview")
def harness_replay_preview(
    slug: str,
    limit: int = 10,
    history_days: int = 180,
    principal: Principal = require_access("marketing"),
) -> dict:
    """The real events a replay WOULD fire on — shown before the button is
    pressed, already-shadow-run events excluded."""
    spec = config.slug_registry().get(_valid_slug(slug))
    if not spec or not spec.get("trigger_key"):
        raise HTTPException(status_code=404, detail="Campaign not registered with a trigger key")
    limit = max(1, min(limit, 25))
    history_days = max(1, min(history_days, 400))
    already = bqstate.shadow_source_keys(slug)
    rows = [
        {**{k: c.get(k) for k in ("dedup_key", "email", "first_name", "last_name", "event_at")},
         "already_run": str(c["dedup_key"]) in already}
        for c in shadow.history_candidates(spec["trigger_key"], limit + len(already), history_days)
    ]
    return {"candidates": rows[: limit + len(already)], "already_run": len(already)}


@app.post("/api/harness/replay/{slug}")
def harness_replay(
    slug: str,
    body: ReplayRequest,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    limit = max(1, min(body.limit, 25))
    history_days = max(1, min(body.history_days, 400))
    try:
        return shadow.replay(_valid_slug(slug), limit, history_days, actor=principal.email)
    except shadow.ShadowGuardError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class ShadowArmRequest(BaseModel):
    armed: bool


@app.post("/api/slugs/{slug}/shadow")
def slugs_shadow_arm(
    slug: str,
    body: ShadowArmRequest,
    principal: Principal = require_access("marketing", "operator"),
) -> dict:
    entry = slugs.update_shadow_armed(_valid_slug(slug), body.armed, actor=principal.email)
    if entry is None:
        raise HTTPException(status_code=404, detail="Campaign not registered")
    return entry


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
