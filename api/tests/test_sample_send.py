"""Guard tests for runner.send_sample's prod modes — the portal's ONLY
prod-firing path, so every refusal branch is pinned:

  composer_seed — prod [1/2] draft/stopped: CIO stores the payload, runs
                  nothing; identity stays SAMPLE_IDENTITY.
  flow_through  — prod [1/2] RUNNING: the actions execute, so the send must
                  (a) carry an owned recipient (@pmygroup.com / @sdfc.dev),
                  (b) have a registered prod event, and (c) find NO running
                  campaign listening on that event. Any miss = no POST.

Plain asserts, no pytest — the api CI job runs `python tests/...` directly.
Nothing here touches CIO or any webhook: CioClient, the campaign matcher and
requests.post are all stubbed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import runner as R  # noqa: E402
from app import validator as V  # noqa: E402


SPEC = {
    "slug": "Prod-Guard-Test-260807",
    "event_name": "Prod-Guard-Test-260807",
    "test_webhook_url": "https://example.invalid/test-hook",
    "prod_webhook_url": "https://example.invalid/prod-hook",
    "payload_fields": ["email"],
    "payload_template": None,
}


class _FakeResponse:
    status_code = 200


class _Posts:
    def __init__(self):
        self.calls = []

    def __call__(self, url, json=None, timeout=None):
        self.calls.append({"url": url, "payload": json})
        return _FakeResponse()


class _FakeCio:
    """Yields a workspace whose prod [1/2] matches SPEC's slug."""

    def __init__(self, trigger_state="running", extra_campaigns=()):
        self._campaigns = [
            {
                "id": 90,
                "name": f"[Trigger] [1/2] {SPEC['slug']}",
                "active": trigger_state == "running",
                "state": trigger_state,
            },
            *extra_campaigns,
        ]

    def campaigns(self):
        return self._campaigns

    def customer_by_email(self, email):
        return {"cio_id": "abc123", "email": email}


def _run(monkey_cio, recipient=None, spec=SPEC, force=False, target="prod", payload=None):
    """send_sample with everything outward stubbed; returns (result, posts)."""
    posts = _Posts()
    orig = (R.get_slug, R.CioClient, R.requests.post, V._match_campaigns)
    R.get_slug = lambda slug: dict(spec)
    R.CioClient = lambda: monkey_cio
    R.requests.post = posts

    def match(campaigns, slug):
        trig = next((c for c in campaigns if f"[1/2] {slug}" in c["name"]), None)
        return {"prod_trigger": trig} if trig else {}

    V._match_campaigns = match
    try:
        result = R.send_sample(
            spec["slug"], target, force=force, recipient=recipient, payload_override=payload
        )
    finally:
        R.get_slug, R.CioClient, R.requests.post, V._match_campaigns = orig
    return result, posts


def main() -> None:
    failures = []

    # 1. Running trigger, no recipient → refused, nothing POSTed.
    res, posts = _run(_FakeCio())
    if "owned recipient" not in (res.get("error") or ""):
        failures.append(f"no-recipient should demand an owned recipient: {res}")
    if posts.calls:
        failures.append("no-recipient case POSTed anyway")

    # 2. Running trigger, fan-domain recipient → refused, nothing POSTed.
    res, posts = _run(_FakeCio(), recipient="fan@gmail.com")
    if "owned recipient" not in (res.get("error") or ""):
        failures.append(f"fan recipient should be refused: {res}")
    if posts.calls:
        failures.append("fan-recipient case POSTed anyway")

    # 3. Running trigger, owned recipient, NO registered prod event → blocked.
    spec_no_event = {**SPEC, "event_name": None}
    res, posts = _run(_FakeCio(), recipient="dean.klear@pmygroup.com", spec=spec_no_event)
    if not res.get("blocked") or "prod trigger event" not in res.get("error", ""):
        failures.append(f"missing event should block: {res}")
    if posts.calls:
        failures.append("missing-event case POSTed anyway")

    # 4. Running trigger, owned recipient, a RUNNING listener on the prod
    #    event → blocked, listener named.
    listener = {
        "id": 91,
        "name": "[PROD] [2/2] Prod-Guard-Test-260807",
        "active": True,
        "event_name": SPEC["event_name"],
    }
    res, posts = _run(_FakeCio(extra_campaigns=[listener]), recipient="dean.klear@pmygroup.com")
    if not res.get("blocked") or "#91" not in res.get("error", ""):
        failures.append(f"running listener should block and be named: {res}")
    if posts.calls:
        failures.append("running-listener case POSTed anyway")

    # 5. Running trigger, owned recipient (subdomain), event clear →
    #    flow-through fires once with the recipient as identity + person link.
    res, posts = _run(_FakeCio(), recipient="check@qa.sdfc.dev")
    if res.get("mode") != "flow_through" or res.get("identity") != "check@qa.sdfc.dev":
        failures.append(f"clear flow-through should fire for the recipient: {res}")
    if len(posts.calls) != 1 or posts.calls[0]["url"] != SPEC["prod_webhook_url"]:
        failures.append(f"flow-through should POST the prod URL once: {posts.calls}")
    if "abc123" not in (res.get("person_url") or ""):
        failures.append(f"flow-through should link the person: {res.get('person_url')}")

    # 6. Draft trigger → composer_seed with SAMPLE_IDENTITY (recipient ignored).
    res, posts = _run(_FakeCio(trigger_state="draft"), recipient="check@qa.sdfc.dev")
    if res.get("mode") != "composer_seed" or res.get("identity") != R.SAMPLE_IDENTITY:
        failures.append(f"draft trigger should composer-seed as SAMPLE_IDENTITY: {res}")
    if len(posts.calls) != 1:
        failures.append("composer-seed should still POST (draft stores, runs nothing)")

    # 7. Unreadable workspace → blocked (fail closed), nothing POSTed.
    class _BrokenCio:
        def campaigns(self):
            raise RuntimeError("cio down")

    res, posts = _run(_BrokenCio())
    if not res.get("blocked") or "unverifiable" not in res.get("error", ""):
        failures.append(f"unreadable CIO should fail closed: {res}")
    if posts.calls:
        failures.append("unreadable-CIO case POSTed anyway")

    # 8. Edited payload smuggling a fan address → refused on the TEST target
    #    too (the running twin would email that fan for real).
    res, posts = _run(
        _FakeCio(),
        target="test",
        payload={"email": "{identity}", "cc": "fan@gmail.com"},
    )
    if "non-owned addresses" not in (res.get("error") or ""):
        failures.append(f"fan address inside an edited payload should refuse: {res}")
    if posts.calls:
        failures.append("edited-payload fan case POSTed anyway")

    # 9. Edited payload, owned addresses only → fires with tokens filled and
    #    the edited fields intact.
    res, posts = _run(
        _FakeCio(),
        recipient="check@qa.sdfc.dev",
        payload={"email": "{identity}", "amount": 9999, "rep_email": "rep@pmygroup.com"},
    )
    if res.get("mode") != "flow_through" or len(posts.calls) != 1:
        failures.append(f"clean edited payload should fire: {res}")
    else:
        sent = posts.calls[0]["payload"]
        if sent.get("email") != "check@qa.sdfc.dev" or sent.get("amount") != 9999:
            failures.append(f"edited payload should fill tokens and keep edits: {sent}")

    if failures:
        for f in failures:
            print("FAIL:", f)
        sys.exit(1)
    print("sample-send prod guards: all assertions passed")


if __name__ == "__main__":
    main()
