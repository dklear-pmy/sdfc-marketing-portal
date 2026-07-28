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
    print("FAILED" if failures else "all canary check paths behave correctly")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
