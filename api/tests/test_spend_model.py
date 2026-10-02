"""Pure tests for the Pipeline Spend page's computation: hour-of-day baselines,
heatmap cells, tiles, DAG state derivation and recipient-list validation. No
credentials, no BigQuery."""

import datetime as dt
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import spend  # noqa: E402

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 2, 14, 7, tzinfo=UTC)


def hourly(days: int, base: float = 2.8, spike_hour: int = 0, spike: float = 7.2):
    rows = []
    start = (NOW - dt.timedelta(days=days)).replace(minute=0, second=0, microsecond=0)
    h = start
    while h < NOW.replace(minute=0, second=0, microsecond=0):
        rows.append({"hour": h, "usd": spike if h.hour == spike_hour else base})
        h += dt.timedelta(hours=1)
    return rows


def test_hour_baselines_use_the_prior_four_weeks_only():
    rows = hourly(40)
    # the last 7 days carry a regression that must NOT leak into the baseline
    for r in rows:
        if r["hour"] >= NOW - dt.timedelta(days=7):
            r["usd"] = 9.9
    b = spend.hour_baselines(rows, NOW)
    assert len(b) == 24
    assert b[0] == 7.2 and b[13] == 2.8


def test_heatmap_cells_cover_seven_days_with_ratios():
    rows = hourly(40)
    b = spend.hour_baselines(rows, NOW)
    cells = spend.heatmap_cells(rows, b, NOW)
    assert len(cells) == 7 * 24
    assert all(c["ratio"] == 1.0 for c in cells if c["actual"] is not None)
    assert cells[-1]["hour"].startswith("2026-10-02T13:00")
    assert "PM" in cells[-1]["hour_pt"] or "AM" in cells[-1]["hour_pt"]


def test_tiles_today_vs_expected_and_month_to_date():
    rows = hourly(40)
    b = spend.hour_baselines(rows, NOW)
    # double today's (Pacific) spend
    today_pt = NOW.astimezone(spend.PT).date()
    for r in rows:
        if r["hour"].astimezone(spend.PT).date() == today_pt:
            r["usd"] *= 2
    t = spend.tiles(rows, b, approved_per_day=70.0, now=NOW)
    assert t["today_so_far"] > t["expected_so_far"] > 0
    assert round(t["today_so_far"] / t["expected_so_far"], 6) == 2.0
    assert t["approved_per_day"] == 70.0
    assert t["mtd"] > 0 and t["last_month_same_point"] > 0
    assert len(t["daily_14"]) == 14 and t["daily_14"][-1]["day_pt"] == (today_pt - dt.timedelta(days=1)).isoformat()
    assert t["projected_month"] > 0


def test_dag_state_derivation():
    assert spend.dag_state("armed", {"status": "learning"}, 0) == "learning"
    assert spend.dag_state("unreviewed_change", {"status": "armed"}, 0) == "unreviewed_change"
    assert spend.dag_state("armed", {"status": "armed"}, 2) == "review"
    assert spend.dag_state("armed", {"status": "armed"}, 0) == "armed"
    assert spend.dag_state(None, None, 0) == "armed"


def test_recipient_list_validation():
    assert spend.valid_list("spend_critical") == "spend_critical"
    try:
        spend.valid_list("marketing")
    except ValueError as e:
        assert "spend_digest" in str(e)
    else:
        raise AssertionError("unknown list accepted")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
