"""Thin Customer.io App API client (read paths used by the validator)."""

import requests

from .config import cio_credentials

_TIMEOUT = 20


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
