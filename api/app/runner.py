"""Test-pair run engine.

A run is a stage machine advanced by repeated `advance_run` calls (frontend
polls while the page is open; Phase 2b adds a Cloud Scheduler tick for long
timers). Stages for the v1 `open_click_all` path:

  created → fired → email1_seen/engaged → email2_seen/engaged → asserted → PASSED

Every stage transition appends to the run's timeline. Timeouts produce
TIMED_OUT with a diagnosis — including the wrong-event-name case, which is
read straight off the probe profile's activity stream (the one wiring bug
static validation cannot see).
"""

import json
import re
from datetime import datetime, timezone

import requests
from google.cloud import secretmanager

from . import bqstate, mailpit, payloads
from .cio import CioClient, person_url
from .config import GCP_PROJECT, PORTAL_BASE_URL, slug_registry
from .slugs import get_slug

EMAIL1_DEADLINE_MIN = 12  # CIO SMTP retries after a transient failure can land within ~10 min
EMAIL2_DEADLINE_MIN = 30  # +10 min journey timer with generous tolerance
# Soft deadlines only kill a run when CIO's delivery ledger shows nothing in
# flight; when a send exists but hasn't delivered, the run waits up to the hard
# cap instead (run 005: email 1 delivered at +21 min, after the timer email).
EMAIL1_HARD_MIN = 35
EMAIL2_HARD_MIN = 50


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _elapsed_min(run: dict) -> float:
    started = datetime.fromisoformat(run["started_at"])
    return (_now() - started).total_seconds() / 60


def _tl(
    run: dict, stage: str, detail: str, msg_id: str | None = None, payload: dict | None = None
) -> list[dict]:
    timeline = run["timeline"]
    entry: dict = {"ts": _now().isoformat(), "stage": stage, "detail": detail}
    if msg_id:
        entry["msg_id"] = msg_id
    if payload is not None:
        entry["payload"] = payload
    timeline.append(entry)
    return timeline


def _engaged_ids(run: dict) -> set[str]:
    return {e["msg_id"] for e in run["timeline"] if e.get("msg_id")}


def _transport_in_flight(cio: CioClient, identity: str) -> bool:
    """True when CIO's delivery ledger has a message for this recipient that
    hasn't recorded delivery yet — the send exists, transport is still working."""
    try:
        ledger = cio.messages_for_recipient(identity)
    except requests.RequestException:
        return False
    return any(not (m.get("metrics") or {}).get("delivered") for m in ledger)


def _hold_for_transport(run_id: str, run: dict, stage: str, hard_min: int) -> None:
    """Note (once) that the run is past its soft deadline but a send is in
    flight; the run stays RUNNING until delivery or the hard cap."""
    if run["timeline"] and run["timeline"][-1].get("stage") == "transport_wait":
        return
    bqstate.update_run(
        run_id,
        status="RUNNING",
        stage=stage,
        timeline=_tl(
            run,
            "transport_wait",
            f"past the {stage} soft deadline but CIO's ledger shows a send still in "
            f"flight — waiting up to {hard_min} min",
        ),
    )


def _webhook_url(spec: dict) -> str:
    """The twin's trigger URL — stored plainly in the registry (internal-only
    portal); Secret Manager id is the legacy fallback for unmigrated entries."""
    if spec.get("test_webhook_url"):
        return spec["test_webhook_url"].strip()
    secret_id = spec["test_webhook_secret"]
    sm = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT}/secrets/{secret_id}/versions/latest"
    return sm.access_secret_version(name=name).payload.data.decode().strip()


def _payload(spec: dict, identity: str, run_id: str) -> dict:
    """The slug's payload template (payloads.py) filled for this identity;
    entries without one get the tb_signup default shape."""
    return payloads.fill(payloads.effective_template(spec), identity)


# The fixed identity for composer samples — deliberately NOT a minted run
# identity: samples exist to seed Customer.io's Trigger data panel (so
# trigger.* references validate), not to exercise a journey, and reusing one
# address keeps the workspace free of throwaway profiles.
SAMPLE_IDENTITY = "scenario-000@qa.sdfc.dev"


# Campaign states where a webhook payload is stored as Trigger data but no
# workflow executes. Anything else (running, or a state we couldn't read)
# means the sample identity would enter the live workflow.
_SAMPLE_SAFE_STATES = {"draft", "stopped", "paused"}


# Recipients a prod flow-through send may address: domains the team owns
# (any subdomain of either). Never a fan address — the [1/2] actions execute
# for real, so the created/updated person must be ours.
_OWNED_RECIPIENT_RE = re.compile(
    r"^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*(?:pmygroup\.com|sdfc\.dev)$", re.I
)


def send_sample(
    slug: str,
    target: str,
    force: bool = False,
    recipient: str | None = None,
    payload_override: dict | None = None,
) -> dict | None:
    """POST one contract-shaped payload at the slug's test or prod inbound
    webhook, outside any run.

    Two prod modes, decided by the prod [1/2] trigger's LIVE state:

    - composer_seed (draft/stopped/paused): Customer.io stores the payload
      as the composer's Trigger data sample and executes nothing — today's
      original behavior, identity stays SAMPLE_IDENTITY.
    - flow_through (running): the [1/2] executes for real — Create or Update
      Person writes the values and Send Event fires the prod event. Guarded
      fail-closed: `recipient` must be an owned address (@pmygroup.com /
      @sdfc.dev, subdomains included) so no fan is touched, and NO running
      campaign may listen on the prod event (verified live — with the [2/2]
      journey off, the values land on the person and stop there). On
      success the response carries a deep link to the person.

    Anything else (unknown/unverifiable state) blocks unless force — the
    legacy escape hatch that skips every gate. Test sends skip the gates:
    firing the twin is the harness's whole job.

    `payload_override` replaces the registry template (tokens like
    {identity} still fill), letting operators hand-shape the demo. Because
    the [1/2] actions key on values INSIDE the payload, an edited payload is
    re-scanned before the POST: every email-shaped token must be an owned
    address, on BOTH targets — a fan address in a test payload would make
    the running twin journey email that fan for real.

    Returns None when the slug is unregistered; {'error': ...} / {'blocked':
    True, ...} when a gate refuses.
    """
    spec = get_slug(slug)
    if spec is None:
        return None
    url = (
        spec.get("prod_webhook_url")
        if target == "prod"
        else spec.get("test_webhook_url")
    )
    if not url:
        return {"error": f"No {target} webhook URL registered for this campaign"}

    state = None
    mode = "composer_seed"
    identity = SAMPLE_IDENTITY
    cio = None
    if target == "prod":
        from .validator import _match_campaigns

        campaigns: list[dict] = []
        try:
            cio = CioClient()
            campaigns = cio.campaigns()
            roles = _match_campaigns(campaigns, slug)
            state = (roles.get("prod_trigger") or {}).get("state")
        except Exception:  # noqa: BLE001 — unreadable state is treated as unsafe below
            state = None

        if state == "running" and not force:
            # Flow-through: the trigger executes, so every guard is hard.
            cleaned = (recipient or "").strip().lower()
            if not _OWNED_RECIPIENT_RE.fullmatch(cleaned):
                return {
                    "error": (
                        "The prod trigger is RUNNING, so this send executes Create or Update "
                        "Person and fires the prod event. Provide an owned recipient "
                        "(@pmygroup.com or @sdfc.dev) — never a fan address."
                    )
                }
            event_name = (spec.get("event_name") or "").strip()
            if not event_name:
                return {
                    "blocked": True,
                    "state": state,
                    "error": (
                        "No prod trigger event is registered, so the portal can't verify that "
                        "nothing listens on it — set the event on the Registration tab first."
                    ),
                }
            listeners = [
                c
                for c in campaigns
                if c.get("active") and (c.get("event_name") or "") == event_name
            ]
            if listeners:
                names = ", ".join(
                    f"#{c.get('id')} {c.get('name', '')}" for c in listeners[:5]
                )
                return {
                    "blocked": True,
                    "state": state,
                    "error": (
                        f"Running campaigns listen on '{event_name}': {names} — a flow-through "
                        "send would enter them. Stop them first, or exercise the twin instead."
                    ),
                }
            mode = "flow_through"
            identity = cleaned
        elif not force and state not in _SAMPLE_SAFE_STATES:
            return {
                "blocked": True,
                "state": state,
                "error": (
                    f"Prod campaign state is '{state or 'unverifiable'}' — a sample would enter "
                    "the live workflow. Fix the state in Customer.io, or force-send if that is "
                    "genuinely intended."
                ),
            }

    template = (
        payload_override
        if payload_override is not None
        else payloads.effective_template(spec)
    )
    payload = payloads.fill(template, identity)
    if payload_override is not None:
        from .shadow import _EMAIL_TOKEN

        bad = sorted(
            {
                tok
                for tok in _EMAIL_TOKEN.findall(json.dumps(payload))
                if not _OWNED_RECIPIENT_RE.fullmatch(tok.lower())
            }
        )
        if bad:
            return {
                "error": (
                    f"Edited payload contains non-owned addresses: {', '.join(bad[:3])} — "
                    "the campaign's actions key on payload values, so only @pmygroup.com / "
                    "@sdfc.dev addresses may ride a demo send."
                )
            }
    resp = requests.post(url.strip(), json=payload, timeout=20)

    # For a flow-through send, hand back a deep link to the person the [1/2]
    # just created/updated — that profile IS the verification surface. CIO
    # may take a moment to materialize a brand-new person; two quick tries,
    # then the UI falls back to "search the email in People".
    person_link = None
    if mode == "flow_through" and resp.status_code in (200, 202) and cio is not None:
        import time as _time

        for attempt in range(2):
            try:
                person = cio.customer_by_email(identity)
                if person and person.get("cio_id"):
                    person_link = person_url(person["cio_id"])
                    break
            except Exception:  # noqa: BLE001 — the link is best-effort, the send already happened
                break
            if attempt == 0:
                _time.sleep(2)

    return {
        "target": target,
        "mode": mode,
        "status_code": resp.status_code,
        "ok": resp.status_code in (200, 202),
        "identity": identity,
        "state": state,
        "person_url": person_link,
        "payload": payload,
    }


# The App API exposes a journey's MESSAGES but none of its workflow structure
# — delays, time windows and branches are invisible (verified 2026-07-30
# against the Shopify twin: 1-week delay + branch, actions list = 3 emails).
# So delay blocks are MEASURED from delivery gaps during a run instead of
# read statically. Anything over the smoke limit is what a smoke-mode run
# must gate with the -smoke@qa.sdfc.dev condition.
SMOKE_DELAY_LIMIT_S = 5 * 60


def _fmt_gap(seconds: float) -> str:
    s = int(seconds)
    if s < 90:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 90:
        return f"{m}m {s:02d}s"
    h, m = divmod(m, 60)
    if h < 48:
        return f"{h}h {m:02d}m"
    return f"{h // 24}d {h % 24}h"


def _delay_profile(started_at: str, messages: list[dict]) -> tuple[str, int]:
    """Measured gaps trigger→delivery→delivery, flagging blocks over the
    smoke limit. Returns ('', 0) when nothing is measurable."""
    prev = datetime.fromisoformat(started_at)
    prev_label = "trigger"
    segments, long_gaps = [], 0
    for m in sorted(messages, key=lambda m: m.get("Created", "")):
        try:
            t = datetime.fromisoformat((m.get("Created") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        gap = (t - prev).total_seconds()
        label = f"'{m.get('Subject')}'"
        flag = gap > SMOKE_DELAY_LIMIT_S
        long_gaps += flag
        segments.append(f"{prev_label} → {label}: {_fmt_gap(gap)}{' (>5m)' if flag else ''}")
        prev, prev_label = t, label
    return "; ".join(segments), long_gaps


# Rendered-content verification: static validation proves the template's
# references RESOLVE; this proves the rendering actually DID. Liquid that
# survives to the delivered MIME is malformed template syntax; a referenced
# field whose minted value shows up nowhere most likely rendered empty
# (Customer.io substitutes missing attributes as blank, not as literal text).
_LEFTOVER_LIQUID = re.compile(r"\{\{|\{%\s*[a-zA-Z]")
# Only fields whose minted values are distinctive enough to search for —
# booleans, dates and zips would false-match ordinary email content.
_ASSERTABLE_FIELDS = ("first_name", "last_name")


def _content_problems(texts: dict[str, str], refs: set[str] | None, payload: dict) -> list[str]:
    """Pure core of the render check. texts = delivered messages (subject +
    decoded body) keyed by a display label; refs = top-level fields the test
    journey's emails reference (None when unreadable — skip value checks)."""
    problems = []
    for label, text in texts.items():
        m = _LEFTOVER_LIQUID.search(text)
        if m:
            snippet = " ".join(text[m.start() : m.start() + 60].split())
            problems.append(f"unrendered Liquid in {label}: '{snippet}'")
    if refs and texts:
        blob = "\n".join(texts.values())
        for field in _ASSERTABLE_FIELDS:
            value = str(payload.get(field) or "")
            if field in refs and value and value not in blob:
                problems.append(
                    f"emails reference {field} but its minted value '{value}' appears in "
                    "no delivery — the substitution likely rendered empty"
                )
    return problems


# Payload-propagation verification: the Variables matrix proves the Send
# Event MAPPING exists; this proves the values actually ARRIVED. The event on
# the probe profile's activity stream is exactly what the journey received, so
# diffing its data against the POSTed payload is end-to-end proof the second
# automation got the full payload.
def _sent_payload(run: dict, spec: dict) -> tuple[dict, set[str]]:
    """What the run actually POSTed (stored on the 'fired' timeline entry).
    Runs fired before that existed fall back to re-filling the template, where
    {now}-bearing fields re-mint and can only be checked for presence."""
    for e in run["timeline"]:
        if e.get("stage") == "fired" and isinstance(e.get("payload"), dict):
            return e["payload"], set()
    template = payloads.effective_template(spec)
    volatile = {k for k, v in template.items() if isinstance(v, str) and "{now}" in v}
    return payloads.fill(template, run["identity"]), volatile


def _event_payload_problems(
    sent: dict, event_data: dict, skip_values: set[str] = frozenset()
) -> tuple[list[str], str]:
    """Field-by-field diff of the POSTed payload vs the journey event's data.
    Returns (problems, human summary); problems are deterministic — a Send
    Event mapping gap won't heal on a later tick."""

    def _same(a, b) -> bool:
        return a == b or str(a).lower() == str(b).lower()

    problems, intact = [], 0
    for field, value in sent.items():
        if field not in event_data:
            problems.append(
                f"payload field '{field}' is missing from the journey event — not mapped "
                "on the trigger's Send Event action"
            )
        elif field in skip_values or _same(value, event_data[field]):
            intact += 1
        else:
            problems.append(
                f"payload field '{field}' arrived altered: sent {value!r}, "
                f"event carries {event_data[field]!r}"
            )
    summary = f"{intact}/{len(sent)} payload fields verified intact on the journey event"
    extras = sorted(set(event_data) - set(sent))
    if extras:
        summary += (
            f"; event carries {len(extras)} mapped field(s) the runner never sent "
            f"(forwarded empty): {', '.join(extras)}"
        )
    return problems, summary


def _run_event(acts: list[dict], expected_event: str | None) -> dict | None:
    """This run's trigger event on the probe profile (identities are minted
    fresh per run, so at most one matching event exists)."""
    for a in acts:
        if a.get("type") == "event" and (not expected_event or a.get("name") == expected_event):
            return a
    return None


def _render_problems(
    cio: CioClient,
    spec: dict,
    slug: str,
    identity: str,
    messages: list[dict],
    sent_payload: dict | None = None,
) -> list[str]:
    texts = {}
    for m in messages:
        subject = m.get("Subject") or ""
        label = f"'{subject}' ({m['ID'][:8]})"
        texts[label] = subject + "\n" + mailpit.rendered_text(mailpit.raw_message(m["ID"]))
    refs: set[str] | None = None
    try:
        from .validator import _liquid_refs, _match_campaigns

        journey = _match_campaigns(cio.campaigns(), slug).get("test_journey")
        if journey:
            r = _liquid_refs(cio.campaign_actions(journey["id"]))
            refs = r["trigger"] | r["event"] | r["customer"]
    except Exception:  # noqa: BLE001 — value assertions are best-effort; the leftover-Liquid scan still ran
        refs = None
    # Value assertions must compare against what was actually SENT — for
    # shadow runs that's a sanitized real row, not the synthetic template.
    payload = sent_payload if sent_payload is not None else _payload(spec, identity, "")
    return _content_problems(texts, refs, payload)


def twin_fire_problems(slug: str, spec: dict, cio=None) -> list[str]:
    """Hard preconditions before ANY fire at the twin webhook — synthetic or
    shadow. The PMY-TEST title and pmy_test_ event prefix are guards, not
    conventions: the twin pair must exist under [PMY-TEST] titles (role
    matching only classifies a campaign as test when the title carries it),
    the pair must run on a pmy_test_* event, and no live production campaign
    may listen on that event (a fire would enter the production journey).
    Unreadable Customer.io state is unsafe — fail closed."""
    from .slugs import TEST_EVENT_PREFIX
    from .validator import _match_campaigns

    problems: list[str] = []
    test_ev = spec.get("test_event_name") or ""
    if not test_ev.startswith(TEST_EVENT_PREFIX):
        problems.append(
            f"registry test event '{test_ev or '(unset)'}' lacks the {TEST_EVENT_PREFIX} prefix"
        )
    try:
        campaigns = (cio or CioClient()).campaigns()
    except Exception as e:  # noqa: BLE001 — unverifiable twin state must block the fire
        return problems + [
            f"cannot read Customer.io to verify the twin pair — refusing to fire ({str(e)[:80]})"
        ]
    roles = _match_campaigns(campaigns, slug)
    for role, label in (("test_trigger", "trigger [1/2]"), ("test_journey", "journey [2/2]")):
        if role not in roles:
            problems.append(
                f"no [PMY-TEST] {label} campaign exists for this slug — a test pair must "
                "carry PMY-TEST in the title"
            )
    twin_ev = (roles.get("test_journey") or {}).get("event_name")
    if twin_ev and not twin_ev.startswith(TEST_EVENT_PREFIX):
        problems.append(
            f"twin journey listens on '{twin_ev}' — test pairs must run on "
            f"{TEST_EVENT_PREFIX}* events"
        )
    watched = {e for e in (test_ev, twin_ev) if e and e.startswith(TEST_EVENT_PREFIX)}
    leaks = [
        f"#{c['id']} {c['name']}"
        for c in campaigns
        if c.get("event_name") in watched
        and "PMY-TEST" not in (c.get("name") or "").upper()
        and c.get("state") == "running"
    ]
    if leaks:
        problems.append(
            "live production campaign(s) listening on this pair's test event: "
            + "; ".join(leaks)
            + " — every test fire would enter the production journey"
        )
    return problems


def start_run(slug: str, actor: str | None) -> dict:
    spec = slug_registry().get(slug)
    if not spec or not (spec.get("test_webhook_url") or spec.get("test_webhook_secret")):
        raise ValueError(f"slug '{slug}' has no test webhook URL in the registry")
    guard = twin_fire_problems(slug, spec)
    if guard:
        raise ValueError("refusing to fire the twin: " + "; ".join(guard))

    run_id = bqstate.create_run(slug, "open_click_all", actor)
    run = bqstate.get_run(run_id)

    url = _webhook_url(spec)
    payload = _payload(spec, run["identity"], run_id)
    resp = requests.post(url, json=payload, timeout=20)
    if resp.status_code not in (200, 202):
        bqstate.update_run(
            run_id,
            status="FAILED",
            stage="fired",
            timeline=_tl(run, "fired", f"webhook HTTP {resp.status_code}: {resp.text[:200]}"),
            detail="Webhook rejected the payload",
        )
        return bqstate.get_run(run_id)

    # The payload rides on the fired entry so the assert tick can diff the
    # journey event against EXACTLY what was sent ({now} fields included).
    bqstate.update_run(
        run_id,
        status="RUNNING",
        stage="fired",
        timeline=_tl(
            run,
            "fired",
            f"webhook HTTP {resp.status_code} for {run['identity']}",
            payload=payload,
        ),
    )
    return bqstate.get_run(run_id)


def _diagnose_missing_email(cio: CioClient, spec: dict, identity: str) -> str:
    """Email never arrived — read the profile to say precisely why."""
    person = cio.customer_by_email(identity)
    if not person:
        return "No CIO profile was created — webhook accepted but Create/Update Person did not run"
    acts = cio.customer_activities(person["cio_id"])
    events = [a.get("name") for a in acts if a.get("type") == "event"]
    expected = spec.get("test_event_name")
    if not events:
        return "Profile exists but no event was emitted — check the trigger half's Send Event action"
    if expected and expected not in events:
        return (
            f"Trigger half emitted {events} but the test journey listens on '{expected}' — event-name "
            "mismatch (the copy-paste bug class); the slug's precheck in Campaign Tester offers a one-click fix"
        )
    # Event was correct — payload gaps explain most entry-filter no-sends
    # (a filter field that forwarded empty silently fails the condition).
    event_act = _run_event(acts, expected)
    if event_act is not None and isinstance(event_act.get("data"), dict):
        template = payloads.effective_template(spec)
        volatile = {k for k, v in template.items() if isinstance(v, str) and "{now}" in v}
        gaps, _ = _event_payload_problems(
            payloads.fill(template, identity), event_act["data"], volatile
        )
        if gaps:
            return "No email sent, and the journey event is missing payload — " + "; ".join(gaps)
    # Distinguish "journey never sent" from "sent but lost in transport".
    ledger = cio.messages_for_recipient(identity)
    if ledger:
        undelivered = [
            m for m in ledger
            if (m.get("metrics") or {}).get("sent") and not (m.get("metrics") or {}).get("delivered")
        ]
        if undelivered:
            subj = undelivered[0].get("subject")
            return (
                f"CIO SENT '{subj}' but delivery to the sink never completed (no bounce recorded) — "
                "SMTP/transport issue between CIO and mail.sdfc.dev, NOT journey config. Re-run to confirm transient."
            )
    return f"Event {events} emitted but no email sent — check journey entry filters/state"


def advance_run(run_id: str) -> dict:
    run = bqstate.get_run(run_id)
    if run is None:
        raise KeyError(run_id)
    if run["status"] != "RUNNING":
        return run

    spec = slug_registry().get(run["slug"]) or {}
    cio = CioClient()
    identity = run["identity"]
    stage = run["stage"]
    messages = mailpit.search_to(identity)
    messages.sort(key=lambda m: m.get("Created", ""))
    # Journey emails can arrive out of order (run 005: the +10-min timer email
    # delivered before email 1's delayed SMTP retry). Engage deliveries in
    # arrival order, tracking which sink messages this run already engaged.
    pending = [m for m in messages if m["ID"] not in _engaged_ids(run)]

    def _engage_next(next_stage: str, ordinal: int) -> None:
        msg = pending[0]
        raw = mailpit.raw_message(msg["ID"])
        result = mailpit.engage(raw, open_pixel=True, click_first=True)
        bqstate.update_run(
            run_id,
            status="RUNNING",
            stage=next_stage,
            timeline=_tl(
                run,
                next_stage,
                f"delivery {ordinal} '{msg.get('Subject')}' arrived {msg.get('Created')}; engaged {result}",
                msg_id=msg["ID"],
            ),
        )

    if stage == "fired":
        if pending:
            _engage_next("email1_engaged", 1)
        elif _elapsed_min(run) > EMAIL1_DEADLINE_MIN:
            if _elapsed_min(run) <= EMAIL1_HARD_MIN and _transport_in_flight(cio, identity):
                _hold_for_transport(run_id, run, stage, EMAIL1_HARD_MIN)
            else:
                diagnosis = _diagnose_missing_email(cio, spec, identity)
                if _elapsed_min(run) > EMAIL1_HARD_MIN:
                    diagnosis = f"hard cap {EMAIL1_HARD_MIN} min reached: {diagnosis}"
                bqstate.update_run(
                    run_id,
                    status="TIMED_OUT",
                    stage="fired",
                    timeline=_tl(run, "timeout", diagnosis),
                    detail=diagnosis,
                )
        return bqstate.get_run(run_id)

    if stage == "email1_engaged":
        if pending:
            _engage_next("email2_engaged", 2)
        elif _elapsed_min(run) > EMAIL2_DEADLINE_MIN:
            if _elapsed_min(run) <= EMAIL2_HARD_MIN and _transport_in_flight(cio, identity):
                _hold_for_transport(run_id, run, stage, EMAIL2_HARD_MIN)
            else:
                detail = "second delivery never arrived — journey timer/branch misconfigured?"
                if _elapsed_min(run) > EMAIL2_HARD_MIN:
                    detail = f"hard cap {EMAIL2_HARD_MIN} min reached: {detail}"
                bqstate.update_run(
                    run_id, status="TIMED_OUT", stage=stage, timeline=_tl(run, "timeout", detail), detail=detail
                )
        return bqstate.get_run(run_id)

    if stage == "email2_engaged":
        person = cio.customer_by_email(identity)
        acts = cio.customer_activities(person["cio_id"]) if person else []
        counts: dict[str, int] = {}
        for a in acts:
            counts[a["type"]] = counts.get(a["type"], 0) + 1
        events = [a.get("name") for a in acts if a.get("type") == "event"]
        expected_event = spec.get("test_event_name")

        metric_problems = []
        if expected_event and expected_event not in events:
            metric_problems.append(
                f"expected event '{expected_event}', profile shows {events} — registry↔CIO drift; "
                "the slug's precheck in Campaign Tester offers a one-click fix"
            )
        for typ, minimum in (("sent_email", 2), ("delivered_email", 2), ("opened_email", 2), ("clicked_email", 2)):
            if counts.get(typ, 0) < minimum:
                metric_problems.append(f"{typ}={counts.get(typ, 0)} (<{minimum})")

        render_note = ""
        try:
            render_problems = _render_problems(
                cio, spec, run["slug"], identity, messages, sent_payload=_sent_payload(run, spec)[0]
            )
        except Exception as e:  # noqa: BLE001 — an unreachable sink must not crash the assert tick
            render_problems = []
            render_note = f" Render check could not run: {str(e)[:100]}."

        # Did the FULL payload exist on the event the journey received?
        payload_problems: list[str] = []
        payload_summary = ""
        event_act = _run_event(acts, expected_event)
        if event_act is not None and isinstance(event_act.get("data"), dict):
            sent, volatile = _sent_payload(run, spec)
            payload_problems, payload_summary = _event_payload_problems(
                sent, event_act["data"], volatile
            )
            _tl(
                run,
                "payload_verified",
                payload_summary
                if not payload_problems
                else "payload check:\n" + "\n".join(payload_problems),
            )
        elif event_act is not None:
            payload_summary = "journey event carries no data payload"
            payload_problems = [
                "the journey event has no data attributes at all — the trigger's Send Event "
                "action forwards nothing"
            ]

        deterministic = render_problems + payload_problems
        problems = metric_problems + deterministic

        # Recorded as its own timeline entry so validation can surface the
        # measured profile (it only persists when this tick goes terminal).
        try:
            delay_line, long_gaps = _delay_profile(run["started_at"], messages)
        except Exception:  # noqa: BLE001
            delay_line, long_gaps = "", 0
        if delay_line:
            profile = f"Delay profile: {delay_line}."
            if long_gaps:
                profile += (
                    f" {long_gaps} block(s) exceed 5 min — gate those delays with the "
                    "-smoke@qa.sdfc.dev condition before smoke-mode runs."
                )
            _tl(run, "delay_profile", profile)

        if not problems:
            detail = (
                f"Activity stream verified: {counts}. "
                f"{payload_summary + '. ' if payload_summary else ''}Render check clean across "
                f"{len(messages)} deliveries.{render_note} Long-tail journey emails (≈+46h timer) "
                "are not tracked by this run — see the sink for later deliveries."
            )
            bqstate.update_run(
                run_id, status="PASSED", stage="asserted", timeline=_tl(run, "asserted", detail), detail=detail
            )
        elif deterministic and not metric_problems:
            # Content and payload-mapping bugs are deterministic — re-asserting
            # later cannot heal them, so fail now rather than waiting out the deadline.
            # One problem per line — the portal splits on newlines to build the
            # problems table (legacy '; ' joins are still parsed there).
            detail = "render/payload checks failed:\n" + "\n".join(deterministic)
            bqstate.update_run(
                run_id, status="FAILED", stage="asserted", timeline=_tl(run, "asserted", detail), detail=detail
            )
        elif _elapsed_min(run) > EMAIL2_DEADLINE_MIN + 10:
            detail = "assertions failed:\n" + "\n".join(problems)
            bqstate.update_run(
                run_id, status="FAILED", stage="asserted", timeline=_tl(run, "asserted", detail), detail=detail
            )
        # else: engagement may still be registering — stay RUNNING and re-assert next tick
        return bqstate.get_run(run_id)

    return run


def advance_all() -> dict:
    """Scheduler tick: advance every RUNNING run. Failures on one run don't
    block the rest. Runs that go terminal-bad while nobody is watching get a
    proactive alert email (manual advances don't — the operator is looking)."""
    from . import emailer

    results: dict[str, str] = {}
    went_bad: list[dict] = []
    for run_id in bqstate.running_run_ids():
        try:
            run = advance_run(run_id)
            results[run_id] = f"{run['status']}:{run['stage']}"
            if run["status"] in ("FAILED", "TIMED_OUT"):
                went_bad.append(run)
        except Exception as e:  # noqa: BLE001 — tick must survive per-run failures
            results[run_id] = f"ERROR:{e}"

    alert = None
    if went_bad:
        lines = "\n".join(
            f"- {r['run_id']} ({r['slug']}, {r['identity']}): {r['status']} — "
            f"{(r.get('detail') or '').replace(chr(10), '; ')}"
            for r in went_bad
        )
        alert = emailer.send_alert(
            subject=f"[Campaign Tester] {len(went_bad)} run{'s' if len(went_bad) > 1 else ''} failed unattended",
            text_body=f"Runs that went terminal on the scheduler tick:\n\n{lines}\n\n"
            f"Details: {PORTAL_BASE_URL}/harness",
        )
    return {"advanced": len(results), "runs": results, "alert": alert}


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the harness E2E for a slug (CLI)")
    parser.add_argument("slug")
    parser.add_argument("--advance", metavar="RUN_ID", help="advance an existing run instead of starting one")
    args = parser.parse_args()
    result = advance_run(args.advance) if args.advance else start_run(args.slug, actor="cli")
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
