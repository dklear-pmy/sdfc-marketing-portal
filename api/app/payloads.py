"""Per-slug webhook payload templates.

A registry entry may carry `payload_template` — a JSON object mirroring what
the production relay (cio_trigger_hub triggers.py) sends for that journey, so
a run exercises the same input shape prod will. Entries without a template
fall back to the tb_signup shape the harness has always sent (correct for
Welcome-General, whose relay trigger IS a signup).

String values may embed tokens, filled at fire time:

  {identity}     the run's minted email (scenario-NNN@qa.sdfc.dev)
  {num}          the scenario number as an integer
  {num3}         the scenario number zero-padded to 3 digits
  {now}          fire time, ISO-8601 UTC (2026-07-31T10:16:09Z)
  {activity_id}  990000000 + num — a collision-free synthetic integer id
  {dedup_key}    str(activity_id)

A string that is EXACTLY one token keeps that token's native type ({num} and
{activity_id} substitute as integers); tokens inside longer strings substitute
as text. Lives in its own module because both the runner (fills it) and the
registry (validates it, prechecks against it) need it without importing each
other.
"""

import json
import re
from datetime import datetime, timezone

_TOKEN = re.compile(r"\{([a-z0-9_]+)\}")

KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

# Shown next to the template editor in Campaign Tester.
TOKEN_DOC: dict[str, str] = {
    "{identity}": "the run's minted email (scenario-NNN@qa.sdfc.dev) — required as the email value",
    "{num}": "the scenario number, as an integer",
    "{num3}": "the scenario number zero-padded to 3 digits",
    "{now}": "fire time, ISO-8601 UTC",
    "{activity_id}": "990000000 + scenario number — a collision-free synthetic integer id",
    "{dedup_key}": "the synthetic id as a string, for dedup-key fields",
}

DEFAULT_TEMPLATE: dict = {
    "dedup_key": "{dedup_key}",
    "email": "{identity}",
    "activity_id": "{activity_id}",
    "campaign_title": "San Diego FC / Stay Informed",
    "signup_form_family": "stay_informed",
    "is_world_cup": False,
    "is_new_fan_24h": True,
    "fan_created_at": "{now}",
    "activity_at": "{now}",
    "first_name": "Scenario",
    "last_name": "Harness {num3}",
    "fan_source": "",
    "phone_subscribed": False,
    "has_season_plan": False,
    "postal_code": "92101",
}


def _token_values(identity: str) -> dict:
    try:
        num = int(identity.split("-")[1].split("@")[0])
    except (IndexError, ValueError):
        # Shadow-run identities (shadow.*@qa.sdfc.dev) carry no scenario
        # number; template refills for them are diagnostic-only.
        num = 0
    activity_id = 990000000 + num
    return {
        "identity": identity,
        "num": num,
        "num3": f"{num:03d}",
        "now": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "activity_id": activity_id,
        "dedup_key": str(activity_id),
    }


def _fill_value(value, tokens: dict):
    if isinstance(value, str):
        m = _TOKEN.fullmatch(value)
        if m and m.group(1) in tokens:
            return tokens[m.group(1)]  # exact token keeps native type
        return _TOKEN.sub(lambda m: str(tokens.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: _fill_value(v, tokens) for k, v in value.items()}
    if isinstance(value, list):
        return [_fill_value(v, tokens) for v in value]
    return value


def fill(template: dict, identity: str) -> dict:
    return _fill_value(template, _token_values(identity))


def parse_template(raw: str | None) -> dict | None:
    """The template dict from a registry entry's raw JSON, or None when the
    entry has none (or holds junk — validate_entry blocks junk on save, but
    hand-edited rows must not crash the runner)."""
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def effective_template(spec: dict) -> dict:
    return parse_template(spec.get("payload_template")) or DEFAULT_TEMPLATE


def template_problems(raw: str) -> list[str]:
    """Why a raw payload-template string can't be saved; empty when clean."""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        return [f"Payload template is not valid JSON: {e.msg} (line {e.lineno})"]
    if not isinstance(obj, dict):
        return ["Payload template must be a JSON object of field → value"]
    problems = []
    for key in obj:
        if not KEY_RE.match(str(key)):
            problems.append(f"Payload template field '{key}' has an unexpected format")
    if obj.get("email") != "{identity}":
        problems.append(
            'Payload template must contain "email": "{identity}" — the run\'s minted '
            "qa.sdfc.dev identity is how mail stays inside the sink and how the run "
            "finds its own profile"
        )
    known = set(_token_values("scenario-000@qa.sdfc.dev"))

    def _scan(value, path: str) -> None:
        if isinstance(value, str):
            for tok in _TOKEN.findall(value):
                if tok not in known:
                    problems.append(
                        f"Unknown token '{{{tok}}}' in template field '{path}' — "
                        f"available: {', '.join('{' + t + '}' for t in sorted(known))}"
                    )
        elif isinstance(value, dict):
            for k, v in value.items():
                _scan(v, f"{path}.{k}")
        elif isinstance(value, list):
            for i, v in enumerate(value):
                _scan(v, f"{path}[{i}]")

    for k, v in obj.items():
        _scan(v, str(k))
    return problems
