"""Mailpit sink client.

Production path: https://mail.sdfc.dev behind IAP — authenticate with an
SA-signed ID token whose audience is the custom IAP OAuth client. On Cloud Run
`google.oauth2.id_token.fetch_id_token` mints it from the metadata server.

Local dev: user ADC can't mint arbitrary-audience ID tokens; set
MAILPIT_LOCAL_URL (e.g. http://localhost:8025 through
`gcloud compute ssh sdfc-qa-mailpit --tunnel-through-iap -- -L 8025:localhost:8025 -N`).
"""

import os
import quopri
import re

import requests

IAP_AUDIENCE = "133738605371-am7lkejtvrb7tlqe3etg15lpg6c60ifg.apps.googleusercontent.com"
_LOCAL_URL = os.environ.get("MAILPIT_LOCAL_URL")
_BASE = _LOCAL_URL or "https://mail.sdfc.dev"

_OPEN_RE = re.compile(r"https://e\.customeriomail\.com/e/o/[^\s\"'<>)]+")
_CLICK_RE = re.compile(r"https://e\.customeriomail\.com/e/c/[^\s\"'<>)]+")


def _headers() -> dict:
    if _LOCAL_URL:
        return {}
    import google.auth.transport.requests
    import google.oauth2.id_token

    token = google.oauth2.id_token.fetch_id_token(
        google.auth.transport.requests.Request(), IAP_AUDIENCE
    )
    return {"Authorization": f"Bearer {token}"}


def search_to(recipient: str) -> list[dict]:
    r = requests.get(
        f"{_BASE}/api/v1/search",
        params={"query": f"to:{recipient}"},
        headers=_headers(),
        timeout=20,
    )
    r.raise_for_status()
    return r.json().get("messages", [])


def raw_message(message_id: str) -> str:
    r = requests.get(f"{_BASE}/api/v1/message/{message_id}/raw", headers=_headers(), timeout=20)
    r.raise_for_status()
    return r.text


def tracking_urls(raw_mime: str) -> tuple[list[str], list[str]]:
    decoded = quopri.decodestring(raw_mime.encode()).decode("utf-8", errors="replace")
    opens = sorted(set(_OPEN_RE.findall(decoded)))
    clicks = sorted(set(_CLICK_RE.findall(decoded)))
    return opens, clicks


def engage(raw_mime: str, *, open_pixel: bool, click_first: bool) -> dict:
    """GET the pixel and/or first click URL; returns what registered."""
    opens, clicks = tracking_urls(raw_mime)
    out = {"opens_found": len(opens), "clicks_found": len(clicks), "opened": False, "clicked": False}
    ua = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) sdfc-harness"}
    if open_pixel and opens:
        out["opened"] = requests.get(opens[0], headers=ua, timeout=20).status_code == 200
    if click_first and clicks:
        out["clicked"] = requests.get(clicks[0], headers=ua, timeout=20, allow_redirects=False).status_code in (301, 302)
    return out
