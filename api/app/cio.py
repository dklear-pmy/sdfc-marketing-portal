"""Thin Customer.io App API client (read paths used by the validator)."""

import os

import requests

from .config import cio_credentials

_TIMEOUT = 20

# The App API is workspace-scoped but never states which workspace; the id is
# only needed for deep links into the fly.customer.io UI.
CIO_WORKSPACE_ID = os.environ.get("CIO_WORKSPACE_ID", "206769")


def campaign_url(campaign_id: int | str) -> str:
    """Deep link to a campaign in the Customer.io app."""
    return f"https://fly.customer.io/workspaces/{CIO_WORKSPACE_ID}/journeys/campaigns/{campaign_id}/overview"


class CioClient:
    def __init__(self):
        creds = cio_credentials()
        self.base = creds.get("base_url", "https://api.customer.io/v1").rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {creds['api_key']}"

    def _get(self, path: str, **params) -> dict:
        r = self.session.get(f"{self.base}{path}", params=params, timeout=_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def campaigns(self) -> list[dict]:
        return self._get("/campaigns")["campaigns"]

    def campaign_actions(self, campaign_id: int) -> list[dict]:
        return self._get(f"/campaigns/{campaign_id}/actions").get("actions", [])

    def customer_by_email(self, email: str) -> dict | None:
        results = self._get("/customers", email=email).get("results", [])
        return results[0] if results else None

    def customer_activities(self, cio_id: str, limit: int = 100) -> list[dict]:
        return self._get(
            f"/customers/{cio_id}/activities", id_type="cio_id", limit=limit
        ).get("activities", [])

    def customer_attributes(self, cio_id: str) -> dict:
        """Full customer object: attributes plus per-attribute write timestamps
        (unix seconds) and the top-level unsubscribed flag."""
        return self._get(f"/customers/{cio_id}/attributes", id_type="cio_id").get(
            "customer", {}
        )

    def customer_segments(self, cio_id: str) -> list[dict]:
        return self._get(f"/customers/{cio_id}/segments", id_type="cio_id").get(
            "segments", []
        )

    def customer_activities_page(
        self, cio_id: str, limit: int = 20, start: str | None = None
    ) -> dict:
        """One page of the person's activity stream; response carries a `next`
        cursor ('' when exhausted)."""
        params: dict = {"id_type": "cio_id", "limit": limit}
        if start:
            params["start"] = start
        return self._get(f"/customers/{cio_id}/activities", **params)

    def customer_messages_page(
        self, cio_id: str, limit: int = 20, start: str | None = None
    ) -> dict:
        """One page of the person's delivery ledger (subject + sent/delivered/
        opened/clicked metrics). Unlike /v1/messages this IS scoped server-side."""
        params: dict = {"id_type": "cio_id", "limit": limit}
        if start:
            params["start"] = start
        return self._get(f"/customers/{cio_id}/messages", **params)

    def messages_for_recipient(self, email: str, limit: int = 50) -> list[dict]:
        """Delivery ledger entries for a recipient, via the person's own
        message page. This used to filter the workspace-wide /messages list
        client-side (the API's recipient param doesn't filter reliably), but
        that window is the newest N messages across ALL recipients — one real
        campaign blast evicts every entry for a single address and reads as
        "no messages ever" (the 2026-07-29 'Early Access' false alarm)."""
        person = self.customer_by_email(email)
        if not person:
            return []
        return self.customer_messages_page(person["cio_id"], limit=limit).get("messages", [])
