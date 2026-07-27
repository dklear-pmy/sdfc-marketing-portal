"""Stadium heatmap: per-section sales/occupancy for Snapdragon Stadium events.

Reads (BQ us-west2, dataset-ACL READER on public_data only — both are
authorized views, so no access to the underlying gold/silver datasets):
  - `public_data.vw_snapdragon_section_heat` — event × section metrics +
    planar centroids; sourced from ticketmaster_gold.tb_seats_combined,
    which refreshes 3×/hour with the ticketmaster_combined DAG.
  - `public_data.vw_snapdragon_events` — event picker rows (dates via
    ticketmaster_silver.optimized_tb_crm_events).

Section polygon geometry ships with the frontend as a static asset; source
of truth is the sdfc-stadium-map repo (Ticketmaster placeDetail export).
"""

import datetime as dt
import decimal
import threading
import time

from .bqstate import client
from .config import GCP_PROJECT

_PUBLIC = f"{GCP_PROJECT}.public_data"
_TTL_SECONDS = 300

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _cached(key: str, build):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL_SECONDS:
            return hit[1]
    data = build()
    with _cache_lock:
        _cache[key] = (time.monotonic(), data)
    return data


def _json_safe(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    return v


def _rows(sql: str) -> list[dict]:
    return [{k: _json_safe(v) for k, v in dict(r).items()} for r in client().query(sql).result()]


def events() -> dict:
    """All events with sellable inventory, dated ones first (upcoming soonest
    → most recent past), undated tail alphabetical. `next_event` = soonest
    event dated today or later — the frontend's default selection."""

    def build() -> dict:
        rows = _rows(
            f"""
            SELECT event_name, event_date, sections, sold, occupied, scanned,
                   total_seats, pct_sold, pct_occupied
            FROM `{_PUBLIC}.vw_snapdragon_events`
            ORDER BY event_date IS NULL, event_date DESC, event_name
            """
        )
        today = dt.date.today().isoformat()
        upcoming = sorted(
            (r for r in rows if r["event_date"] and r["event_date"] >= today),
            key=lambda r: r["event_date"],
        )
        future = [r for r in upcoming if r["total_seats"]]
        return {
            "events": rows,
            "next_event": future[0]["event_name"] if future else None,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }

    return _cached("events", build)


def heat(event: str) -> dict:
    """Per-section metrics for one event. `event` may be the literal "next"."""
    if event == "next":
        resolved = events()["next_event"]
        if not resolved:
            raise KeyError("No upcoming event with inventory")
        event = resolved

    def build() -> dict:
        # event names come from our own events list; parameterize anyway.
        from google.cloud import bigquery

        rows = [
            {k: _json_safe(v) for k, v in dict(r).items()}
            for r in client()
            .query(
                f"""
                SELECT section, data_code, category, sold, occupied, scanned,
                       total_seats, pct_sold, cx, cy
                FROM `{_PUBLIC}.vw_snapdragon_section_heat`
                WHERE event_name = @event
                ORDER BY section
                """,
                job_config=bigquery.QueryJobConfig(
                    query_parameters=[bigquery.ScalarQueryParameter("event", "STRING", event)]
                ),
            )
            .result()
        ]
        return {
            "event": event,
            "sections": rows,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }

    data = _cached(f"heat:{event}", build)
    if not data["sections"]:
        raise KeyError(f"Unknown event: {event}")
    return data
