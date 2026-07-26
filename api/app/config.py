"""Configuration. The GCP project is hardcoded per repo policy — never inferred."""

import json
import os
from functools import lru_cache
from pathlib import Path

import yaml

GCP_PROJECT = "sdfc-udp-dev"

CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS", "https://marketing.sdfc.dev,http://localhost:5173"
    ).split(",")
    if o.strip()
]

# Local-dev escape hatch only. Refused unless ENV=local so it can never be
# switched on in a deployed revision by a stray env var.
AUTH_DISABLED = os.environ.get("DISABLE_AUTH") == "1" and os.environ.get("ENV") == "local"

# Cloud Scheduler → tick endpoint OIDC contract.
PORTAL_SA_EMAIL = "marketing-portal-sa@sdfc-udp-dev.iam.gserviceaccount.com"
TICK_AUDIENCE = os.environ.get("TICK_AUDIENCE", "sdfc-marketing-portal-tick")

_SLUG_REGISTRY_PATH = Path(__file__).parent.parent / "config" / "slugs.yaml"


@lru_cache(maxsize=1)
def slug_registry() -> dict:
    with open(_SLUG_REGISTRY_PATH) as f:
        return yaml.safe_load(f)["slugs"]


@lru_cache(maxsize=1)
def cio_credentials() -> dict:
    """{api_key, base_url} from Secret Manager."""
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT}/secrets/customerio-credentials/versions/latest"
    payload = client.access_secret_version(name=name).payload.data.decode()
    return json.loads(payload)


def secret_exists(secret_id: str) -> bool | None:
    """True/False if determinable, None if we lack permission."""
    from google.api_core import exceptions as gexc
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT}/secrets/{secret_id}/versions/latest"
    try:
        client.access_secret_version(name=name)
        return True
    except gexc.NotFound:
        return False
    except gexc.PermissionDenied:
        return None
