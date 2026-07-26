"""Proactive alert email via Postmark (server "sdfc.dev", token in Secret
Manager `postmark-marketing-token`).

Sends are strictly best-effort: alerting must never break the tick that
produced the alert, so every failure — including "not a Sender Signature"
while the sdfc.dev domain's DKIM verification is still pending in Postmark —
is returned as {sent: False, detail} rather than raised.

Recipients default to the ops owner; override with ALERT_EMAILS (comma-
separated — when setting via `gcloud run deploy` use the ^|^ delimiter form
so the commas survive). ALERT_FROM must stay on @sdfc.dev, the only domain
this Postmark server will verify.
"""

import os
from functools import lru_cache

import requests

from .config import GCP_PROJECT

_POSTMARK_EMAIL_API = "https://api.postmarkapp.com/email"

ALERT_FROM = os.environ.get("ALERT_FROM", "SDFC Marketing Ops <alerts@sdfc.dev>")
ALERT_RECIPIENTS = [
    e.strip()
    for e in os.environ.get("ALERT_EMAILS", "dean.klear@pmygroup.com").split(",")
    if e.strip()
]


@lru_cache(maxsize=1)
def _server_token() -> str:
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT}/secrets/postmark-marketing-token/versions/latest"
    return client.access_secret_version(name=name).payload.data.decode().strip()


def send_alert(subject: str, text_body: str) -> dict:
    """Send a plain-text alert to the configured recipients. Never raises."""
    try:
        r = requests.post(
            _POSTMARK_EMAIL_API,
            json={
                "From": ALERT_FROM,
                "To": ", ".join(ALERT_RECIPIENTS),
                "Subject": subject,
                "TextBody": text_body,
                "MessageStream": "outbound",
            },
            headers={"X-Postmark-Server-Token": _server_token(), "Accept": "application/json"},
            timeout=15,
        )
        if r.status_code == 200:
            return {"sent": True, "to": ALERT_RECIPIENTS, "detail": None}
        return {"sent": False, "to": ALERT_RECIPIENTS, "detail": f"Postmark HTTP {r.status_code}: {r.text[:200]}"}
    except Exception as e:  # noqa: BLE001 — alerting is best-effort by contract
        return {"sent": False, "to": ALERT_RECIPIENTS, "detail": f"send error: {str(e)[:200]}"}
