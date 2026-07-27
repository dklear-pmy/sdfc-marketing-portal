"""Proactive alert email via Postmark (server "sdfc.dev", token in Secret
Manager `postmark-marketing-token`).

Sends are strictly best-effort: alerting must never break the tick that
produced the alert, so every failure — including "not a Sender Signature"
while the sdfc.dev domain's DKIM verification is still pending in Postmark —
is returned as {sent: False, detail} rather than raised.

Recipients are UI-managed (Admin → Alert recipients) in
`customerio_state.alert_recipients`, read at send time; if the table is empty
or unreachable the ops owner is the fallback so alerts can never go nowhere.
ALERT_FROM must stay on @sdfc.dev, the only domain this Postmark server will
verify.
"""

import os
from functools import lru_cache

import requests
from google.cloud import bigquery

from .config import GCP_PROJECT

_POSTMARK_EMAIL_API = "https://api.postmarkapp.com/email"
_RECIPIENTS_TABLE = f"{GCP_PROJECT}.customerio_state.alert_recipients"

ALERT_FROM = os.environ.get("ALERT_FROM", "SDFC Marketing Ops <alerts@sdfc.dev>")
FALLBACK_RECIPIENT = "dean.klear@pmygroup.com"


def recipients() -> list[str]:
    try:
        from .bqstate import client

        rows = list(
            client()
            .query(f"SELECT email FROM `{_RECIPIENTS_TABLE}` WHERE active ORDER BY email")
            .result()
        )
        return [r.email for r in rows] or [FALLBACK_RECIPIENT]
    except Exception:  # noqa: BLE001 — never let recipient lookup block an alert
        return [FALLBACK_RECIPIENT]


def list_recipients() -> list[dict]:
    from .bqstate import client

    rows = client().query(
        f"SELECT email, label, added_by, added_at FROM `{_RECIPIENTS_TABLE}` WHERE active ORDER BY added_at"
    ).result()
    out = []
    for r in rows:
        d = dict(r)
        d["added_at"] = d["added_at"].isoformat() if d.get("added_at") else None
        out.append(d)
    return out


def add_recipient(email: str, label: str | None, actor: str | None) -> dict:
    from .bqstate import client

    client().query(
        f"""
        MERGE `{_RECIPIENTS_TABLE}` t USING (SELECT @email AS email) s ON t.email = s.email
        WHEN MATCHED THEN UPDATE SET active = TRUE, label = @label
        WHEN NOT MATCHED THEN INSERT (email, label, added_by, added_at, active)
          VALUES (@email, @label, @actor, CURRENT_TIMESTAMP(), TRUE)
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("email", "STRING", email),
                bigquery.ScalarQueryParameter("label", "STRING", label),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
            ]
        ),
    ).result()
    return {"email": email, "label": label}


def remove_recipient(email: str) -> dict:
    from .bqstate import client

    client().query(
        f"DELETE FROM `{_RECIPIENTS_TABLE}` WHERE email = @email",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", email)]
        ),
    ).result()
    return {"email": email, "removed": True}


@lru_cache(maxsize=1)
def _server_token() -> str:
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT}/secrets/postmark-marketing-token/versions/latest"
    return client.access_secret_version(name=name).payload.data.decode().strip()


def send_alert(subject: str, text_body: str) -> dict:
    """Send a plain-text alert to the configured recipients. Never raises."""
    to = recipients()
    try:
        r = requests.post(
            _POSTMARK_EMAIL_API,
            json={
                "From": ALERT_FROM,
                "To": ", ".join(to),
                "Subject": subject,
                "TextBody": text_body,
                "MessageStream": "outbound",
            },
            headers={"X-Postmark-Server-Token": _server_token(), "Accept": "application/json"},
            timeout=15,
        )
        if r.status_code == 200:
            return {"sent": True, "to": to, "detail": None}
        return {"sent": False, "to": to, "detail": f"Postmark HTTP {r.status_code}: {r.text[:200]}"}
    except Exception as e:  # noqa: BLE001 — alerting is best-effort by contract
        return {"sent": False, "to": to, "detail": f"send error: {str(e)[:200]}"}
