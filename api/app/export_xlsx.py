"""Excel export of the Matching Customers preview — one row per event, the
payload fields flattened into columns (the on-screen table shows the payload
only behind a per-row View toggle; the export is where you get it in bulk).

Works for both windows: days=None exports the live next-run selection,
days=N the trailing-N-days history. Strictly display-side — reads the same
view/TVF the preview reads and can never send a webhook.
"""

import datetime as dt
import io
import json
import re

from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from . import affected

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

_PACIFIC = ZoneInfo("America/Los_Angeles")

# Far above any real preview (largest known: tb_signup 90d ≈ 10.5k). If a
# window somehow exceeds it, the file says so in its last row rather than
# silently truncating.
EXPORT_MAX = 20_000

# Identity columns lead, in the order the on-screen table implies; remaining
# payload keys follow in first-seen payload order.
_LEAD = ["email", "first_name", "last_name"]


def _pacific(iso: str | None):
    """ISO timestamp -> naive Pacific datetime (Excel-sortable, matches the
    UI's Pacific rendering). Naive because Excel has no timezone concept."""
    if not iso:
        return None
    try:
        t = dt.datetime.fromisoformat(iso)
    except ValueError:
        return iso
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(_PACIFIC).replace(tzinfo=None)


def _cell(key: str, v):
    """Payload value -> Excel cell value."""
    if v is None:
        return None
    # The one epoch field in the membership payload — raw seconds are useless
    # to a marketer, so it lands as a Pacific datetime like event_at.
    if key == "ticketing_event_date" and isinstance(v, (int, float)) and not isinstance(v, bool):
        return dt.datetime.fromtimestamp(v, tz=dt.timezone.utc).astimezone(_PACIFIC).replace(tzinfo=None)
    if isinstance(v, str):
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            return dt.date.fromisoformat(v)  # close_date etc. sort as dates
        if v[:1] in "=+-@":
            # openpyxl writes a leading-= string as a live formula; the
            # apostrophe is Excel's own text-literal marker.
            return "'" + v
    return v


def preview_xlsx(
    trigger_key: str, days: int | None = None, q: str | None = None
) -> tuple[str, bytes]:
    """(filename, xlsx bytes) for a trigger's preview window."""
    rows, total = affected._preview_rows(trigger_key, q, EXPORT_MAX, 0, days)

    # Column union across every row's payload, first-seen order, identity first.
    cols = list(_LEAD)
    payloads: list[dict] = []
    for r in rows:
        p = {}
        if r.get("payload_json"):
            try:
                p = json.loads(r["payload_json"])
            except ValueError:
                p = {}
        payloads.append(p)
        for k in p:
            # dedup_key rides in the payload too — it gets the dedicated
            # last column instead of a duplicate here.
            if k not in cols and k != "dedup_key":
                cols.append(k)

    header = ["event_at (PT)"] + cols + ["dedup_key"]
    wb = Workbook()
    ws = wb.active
    ws.title = trigger_key[:31]  # Excel's sheet-name limit
    ws.append(header)
    for c in ws[1]:
        c.font = Font(bold=True)
    ws.freeze_panes = "A2"

    for r, p in zip(rows, payloads):
        # Identity falls back to the row's own columns when a payload lacks it.
        merged = {**{k: r.get(k) for k in _LEAD}, **p}
        ws.append(
            [_pacific(r.get("event_at"))]
            + [_cell(k, merged.get(k)) for k in cols]
            + [r.get("dedup_key")]
        )
    if total > len(rows):
        ws.append([])
        ws.append([f"NOTE: {total - len(rows):,} more rows beyond the {EXPORT_MAX:,}-row export cap"])

    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, dt.datetime):
                cell.number_format = "yyyy-mm-dd hh:mm"
            elif isinstance(cell.value, dt.date):
                cell.number_format = "yyyy-mm-dd"

    # Fit columns to content (sampled — width is cosmetic, not worth 20k rows).
    for i, name in enumerate(header, start=1):
        width = len(str(name))
        for (v,) in ws.iter_rows(min_col=i, max_col=i, min_row=2, max_row=500, values_only=True):
            if v is not None:
                width = max(width, len(str(v)))
        ws.column_dimensions[get_column_letter(i)].width = min(42, width + 2)

    buf = io.BytesIO()
    wb.save(buf)
    window = f"last-{days}-days" if days else "next-run"
    stamp = dt.datetime.now(_PACIFIC).strftime("%Y%m%d-%H%M")
    return f"{trigger_key}--{window}--{stamp}.xlsx", buf.getvalue()
