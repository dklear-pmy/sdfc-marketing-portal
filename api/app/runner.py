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
from datetime import datetime, timezone

import requests
from google.cloud import secretmanager

from . import bqstate, mailpit
from .cio import CioClient
from .config import GCP_PROJECT, slug_registry

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


def _tl(run: dict, stage: str, detail: str, msg_id: str | None = None) -> list[dict]:
    timeline = run["timeline"]
    entry: dict = {"ts": _now().isoformat(), "stage": stage, "detail": detail}
    if msg_id:
        entry["msg_id"] = msg_id
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
    """tb_signup-shaped payload; dedup key derives from the identity number."""
    num = int(identity.split("-")[1].split("@")[0])
    now = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    activity_id = 990000000 + num
    return {
        "dedup_key": str(activity_id),
        "email": identity,
        "activity_id": activity_id,
        "campaign_title": "San Diego FC / Stay Informed",
        "signup_form_family": "stay_informed",
        "is_world_cup": False,
        "is_new_fan_24h": True,
        "fan_created_at": now,
        "activity_at": now,
        "first_name": "Scenario",
        "last_name": f"Harness {num:03d}",
        "fan_source": "",
        "phone_subscribed": False,
        "has_season_plan": False,
        "postal_code": "92101",
    }


def start_run(slug: str, actor: str | None) -> dict:
    spec = slug_registry().get(slug)
    if not spec or not (spec.get("test_webhook_url") or spec.get("test_webhook_secret")):
        raise ValueError(f"slug '{slug}' has no test webhook URL in the registry")

    run_id = bqstate.create_run(slug, "open_click_all", actor)
    run = bqstate.get_run(run_id)

    url = _webhook_url(spec)
    resp = requests.post(url, json=_payload(spec, run["identity"], run_id), timeout=20)
    if resp.status_code not in (200, 202):
        bqstate.update_run(
            run_id,
            status="FAILED",
            stage="fired",
            timeline=_tl(run, "fired", f"webhook HTTP {resp.status_code}: {resp.text[:200]}"),
            detail="Webhook rejected the payload",
        )
        return bqstate.get_run(run_id)

    bqstate.update_run(
        run_id,
        status="RUNNING",
        stage="fired",
        timeline=_tl(run, "fired", f"webhook HTTP {resp.status_code} for {run['identity']}"),
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
        return f"Trigger half emitted {events} but the test journey listens on '{expected}' — event-name mismatch (the copy-paste bug class)"
    # Event was correct — distinguish "journey never sent" from "sent but lost in transport".
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

        problems = []
        if expected_event and expected_event not in events:
            problems.append(f"expected event '{expected_event}', profile shows {events}")
        for typ, minimum in (("sent_email", 2), ("delivered_email", 2), ("opened_email", 2), ("clicked_email", 2)):
            if counts.get(typ, 0) < minimum:
                problems.append(f"{typ}={counts.get(typ, 0)} (<{minimum})")

        if not problems:
            detail = (
                f"Activity stream verified: {counts}. Long-tail journey emails (≈+46h timer) "
                "are not tracked by this run — see the sink for later deliveries."
            )
            bqstate.update_run(
                run_id, status="PASSED", stage="asserted", timeline=_tl(run, "asserted", detail), detail=detail
            )
        elif _elapsed_min(run) > EMAIL2_DEADLINE_MIN + 10:
            detail = "assertions failed: " + "; ".join(problems)
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
            f"- {r['run_id']} ({r['slug']}, {r['identity']}): {r['status']} — {r.get('detail')}"
            for r in went_bad
        )
        alert = emailer.send_alert(
            subject=f"[Campaign Tester] {len(went_bad)} run{'s' if len(went_bad) > 1 else ''} failed unattended",
            text_body=f"Runs that went terminal on the scheduler tick:\n\n{lines}\n\n"
            "Details: https://marketing.sdfc.dev/harness",
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
