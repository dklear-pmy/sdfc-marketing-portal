"""Failure-path tests for the synthetic canary checks.

Plain asserts, no pytest — the api CI job runs `python tests/...` directly,
matching the existing import smoke test. Nothing here touches BigQuery, CIO or
the sink: the CIO client is faked and the clock is frozen, so it runs with no
credentials.

These cover the FAIL branches specifically. A monitor whose failure path has
never fired is not a monitor, and the canary exists precisely so that a quiet
PASS elsewhere is trustworthy — so its own ability to fail has to be pinned
down by tests rather than assumed.
"""

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import tripwires as T  # noqa: E402

NOW = dt.datetime(2026, 7, 28, 12, 0, tzinfo=dt.timezone.utc)
TS = NOW.timestamp()


class FakeCio:
    def __init__(self, messages):
        self._messages = messages

    def messages_for_recipient(self, email, limit=50):
        return self._messages


def check(messages, *, minutes_later=0, sink=()):
    T._now = lambda: NOW + dt.timedelta(minutes=minutes_later)
    T.mailpit.search_to = lambda email: [{"Subject": s} for s in sink]
    rows = T._check_canary(FakeCio(messages))
    return {r["check_name"]: r["status"] for r in rows}


def main() -> int:
    delivered = [{"subject": "canary", "metrics": {"sent": TS - 60, "delivered": TS - 30}}]
    failures = []

    def expect(label, got, name, want):
        if got.get(name) != want:
            failures.append(f"{label}: {name} was {got.get(name)}, expected {want}")

    # Healthy: fresh, delivered, and present in the sink.
    got = check(delivered, sink=["canary"])
    expect("healthy", got, "canary_send", "PASS")
    expect("healthy", got, "canary_delivery", "PASS")
    expect("healthy", got, "canary_sink", "PASS")

    # Never fired at all.
    expect("never fired", check([]), "canary_send", "FAIL")

    # Fired, but the hourly job has stopped — the case that makes every other
    # quiet PASS in the run meaningless, so it must be loud.
    expect("stale 3h", check(delivered, minutes_later=180), "canary_send", "FAIL")

    # Sent but never delivered or bounced, past the delivery deadline.
    overdue = [{"subject": "canary", "metrics": {"sent": TS - 40 * 60}}]
    expect("overdue", check(overdue), "canary_delivery", "FAIL")

    # Still inside the grace window: pending is normal, not a finding.
    inflight = [{"subject": "canary", "metrics": {"sent": TS - 5 * 60}}]
    expect("in flight", check(inflight), "canary_delivery", "PASS")

    # Hard bounce.
    bounced = [{"subject": "canary", "metrics": {"sent": TS - 60, "bounced": TS - 30}}]
    expect("bounced", check(bounced), "canary_delivery", "FAIL")

    # CIO claims delivered but it never reached the sink (sink/MX drift).
    expect("sink drift", check(delivered, sink=[]), "canary_sink", "FAIL")

    # An unreachable sink must WARN without discarding the send and delivery
    # findings, which matter more than the sink cross-check.
    T._now = lambda: NOW
    T.mailpit.search_to = lambda email: (_ for _ in ()).throw(RuntimeError("no IAP token"))
    rows = T._check_canary(FakeCio(delivered))
    got = {r["check_name"]: r["status"] for r in rows}
    expect("sink down", got, "canary_sink", "WARN")
    expect("sink down", got, "canary_send", "PASS")
    expect("sink down", got, "canary_delivery", "PASS")

    # The newest send is the one judged, regardless of ledger ordering.
    out_of_order = [
        {"subject": "old", "metrics": {"sent": TS - 5 * 3600, "delivered": TS - 5 * 3600}},
        {"subject": "new", "metrics": {"sent": TS - 60, "delivered": TS - 30}},
    ]
    expect("newest wins", check(out_of_order, sink=["new"]), "canary_sink", "PASS")

    for f in failures:
        print(f"FAIL  {f}")

    failures += test_resub_guard()

    print("FAILED" if failures else "all canary check paths behave correctly")
    return 1 if failures else 0


RAW_WITH_UNSUB = (
    "List-Unsubscribe: <mailto:ABC@unsubscribe2.customer.io>,\r\n"
    " <https://e.customeriomail.com/unsubscribe/dgSxzwwBAOHnGeDnGQGfn_18v3zaSY7ducHh1_U=>\r\n"
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"
    "Subject: hi\r\n\r\nbody\r\n"
)


def test_resub_guard() -> list:
    """make_resub_guard: the action that turns a tripwire into the July
    resub-loop's inverse listener. All collaborators faked — no sink, no CIO."""
    failures = []

    url = T.mailpit.unsubscribe_url(RAW_WITH_UNSUB)
    if url != "https://e.customeriomail.com/unsubscribe/dgSxzwwBAOHnGeDnGQGfn_18v3zaSY7ducHh1_U=":
        failures.append(f"unsubscribe_url extraction: {url}")
    if T.mailpit.unsubscribe_url("Subject: hi\r\n\r\nno links here") is not None:
        failures.append("unsubscribe_url must be None when absent")

    class FakeCioGuard:
        def __init__(self, unsub):
            self._unsub = unsub

        def customer_by_email(self, email):
            return {"cio_id": "abc"}

        def customer_attributes(self, cio_id):
            return {"unsubscribed": self._unsub}

    posts = []
    updates = []
    T.list_tripwires = lambda active_only=False: [{"email": "guard@qa.sdfc.dev"}]
    T.mailpit.search_to = lambda email: [{"ID": "m1", "Created": "2026-07-29"}]
    T.mailpit.raw_message = lambda mid: RAW_WITH_UNSUB
    T.requests.post = lambda url, **kw: posts.append((url, kw.get("data"))) or type("R", (), {"status_code": 200})()
    T.CioClient = lambda: FakeCioGuard(True)
    T.update_tripwire = lambda email, **kw: updates.append((email, kw))
    T.time.sleep = lambda s: None

    out = T.make_resub_guard("guard@qa.sdfc.dev")
    if not (out["unsubscribed"] and out["expect_subscribed"] is False):
        failures.append(f"happy path result: {out}")
    if posts[0][1] != {"List-Unsubscribe": "One-Click"}:
        failures.append(f"one-click POST body wrong: {posts[0]}")
    if updates != [("guard@qa.sdfc.dev", {"expect_subscribed": False})]:
        failures.append(f"expectation flip wrong: {updates}")

    for bad_email, label in (("other@qa.sdfc.dev", "unknown tripwire"),):
        try:
            T.make_resub_guard(bad_email)
            failures.append(f"{label}: should have raised")
        except ValueError:
            pass

    T.mailpit.search_to = lambda email: []
    try:
        T.make_resub_guard("guard@qa.sdfc.dev")
        failures.append("no sink messages: should have raised")
    except ValueError as e:
        if "provision" not in str(e):
            failures.append(f"no-message error unhelpful: {e}")

    T.mailpit.search_to = lambda email: [{"ID": "m1", "Created": "2026-07-29"}]
    T.CioClient = lambda: FakeCioGuard(False)
    try:
        T.make_resub_guard("guard@qa.sdfc.dev")
        failures.append("unconfirmed flip: should have raised")
    except ValueError:
        pass

    for f in failures:
        print(f"FAIL  {f}")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
