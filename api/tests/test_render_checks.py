"""Variable-coverage tests for campaign templates, both halves of the story:

  static  — validator._liquid_refs/_liquid_gaps: references a journey's emails
            make vs what the trigger actually supplies
  runtime — runner._content_problems: what was DELIVERED renders clean (no
            leftover Liquid, referenced minted values actually present)

Plain asserts, no pytest — the api CI job runs `python tests/...` directly.
Nothing here touches CIO or the sink.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import mailpit  # noqa: E402
from app import runner as R  # noqa: E402
from app.validator import (  # noqa: E402
    _liquid_gaps,
    _liquid_ref_sites,
    _liquid_ref_snippets,
    _liquid_refs,
)


def test_static_refs() -> list:
    failures = []

    actions = [
        {"type": "email", "subject": "Hi {{ customer.first_name }}", "body": "<p>{{trigger.promo_code}} and {{event.order_id}}</p>", "body_plain": "{{customer.address.city}}"},
        {"type": "create_event", "body": "[]"},  # non-email actions are ignored
        {"type": "email", "body": "{{ trigger.promo_code }} again"},
    ]
    refs = _liquid_refs(actions)
    if refs["customer"] != {"first_name", "address"}:
        failures.append(f"customer refs (top-level only): {refs['customer']}")
    if refs["trigger"] != {"promo_code"}:
        failures.append(f"trigger refs: {refs['trigger']}")
    if refs["event"] != {"order_id"}:
        failures.append(f"event refs: {refs['event']}")

    # Findings must point at the exact email to edit.
    sites = _liquid_ref_sites(actions)
    if sites["event"]["order_id"] != {"Hi {{ customer.first_name }}"}:
        failures.append(f"event.order_id site: {sites['event']['order_id']}")
    if sites["trigger"]["promo_code"] != {"Hi {{ customer.first_name }}", "action None"}:
        failures.append(f"promo_code must list every email using it: {sites['trigger']['promo_code']}")

    gaps = _liquid_gaps(refs, event_fields={"promo_code"}, person_fields={"first_name"})
    if gaps["trigger"]:
        failures.append(f"promo_code is in the mapping — no trigger gap expected: {gaps['trigger']}")
    if gaps["event"] != {"order_id"}:
        failures.append(f"order_id missing from mapping must flag: {gaps['event']}")
    if gaps["customer"] != {"address"}:
        failures.append(f"unknown customer attr must flag: {gaps['customer']}")

    # No readable Send Event mapping → the event scopes cannot be judged.
    gaps = _liquid_gaps(refs, event_fields=set(), person_fields=set())
    if gaps["trigger"] or gaps["event"]:
        failures.append(f"empty mapping must not false-flag trigger/event: {gaps}")
    if gaps["customer"] != {"first_name", "address"}:
        failures.append(f"customer gap independent of mapping: {gaps['customer']}")

    for f in failures:
        print(f"FAIL  {f}")
    return failures


def test_runtime_content() -> list:
    failures = []
    payload = {"first_name": "Scenario", "last_name": "Harness 007"}

    clean = {"'Welcome' (abc)": "Subject\nHi Scenario, welcome to SDFC!"}
    if R._content_problems(clean, {"first_name"}, payload):
        failures.append("clean render must produce no problems")

    leftover = {"'Welcome' (abc)": "Hi {{customer.frist_name}}, welcome!"}
    got = R._content_problems(leftover, None, payload)
    if not (len(got) == 1 and "unrendered Liquid" in got[0] and "frist_name" in got[0]):
        failures.append(f"literal {{{{ must flag with a snippet: {got}")

    tag = {"'W' (abc)": "start {% if customer.vip %}gold{% endif %} end"}
    if not R._content_problems(tag, None, payload):
        failures.append("unrendered {% tag %} must flag")

    css = {"'W' (abc)": "<style>@keyframes x { 0% {opacity:0} 100% {opacity:1} }</style>Hi Scenario"}
    if R._content_problems(css, {"first_name"}, payload):
        failures.append("CSS keyframes braces must not false-flag")

    # first_name referenced but its minted value nowhere → likely empty render.
    empty_sub = {"'W' (abc)": "Hi , welcome to SDFC!"}
    got = R._content_problems(empty_sub, {"first_name"}, payload)
    if not (len(got) == 1 and "rendered empty" in got[0] and "Scenario" in got[0]):
        failures.append(f"missing referenced value must flag: {got}")
    if R._content_problems(empty_sub, {"promo_code"}, payload):
        failures.append("unreferenced fields must not be asserted")
    if R._content_problems(empty_sub, None, payload):
        failures.append("refs unavailable → value assertions must be skipped")

    # Quoted-printable can split `{{` across a soft line break — the decoded
    # text must still expose it to the leftover-Liquid scan.
    raw = "Subject: x\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHi {=\r\n{customer.name}}!"
    decoded = mailpit.rendered_text(raw)
    if "{{customer.name}}" not in decoded:
        failures.append(f"soft-break split braces must decode back together: {decoded[-40:]!r}")
    if not R._content_problems({"'x' (abc)": decoded}, None, payload):
        failures.append("decoded soft-break Liquid must flag")

    for f in failures:
        print(f"FAIL  {f}")
    return failures


def test_delay_profile() -> list:
    failures = []
    started = "2026-07-30T20:00:00+00:00"
    messages = [
        {"Subject": "Welcome", "Created": "2026-07-30T20:00:09.5Z"},
        {"Subject": "Promo", "Created": "2026-07-30T20:10:30Z"},
    ]
    line, long_gaps = R._delay_profile(started, messages)
    if long_gaps != 1:
        failures.append(f"the ten-minute gap must count as long: {long_gaps}")
    if "trigger → 'Welcome': 9s" not in line or "'Welcome' → 'Promo': 10m 20s (>5m)" not in line:
        failures.append(f"profile wording: {line}")
    if R._delay_profile(started, []) != ("", 0):
        failures.append("no deliveries → empty profile")
    # A week-long gap formats in days, not an integer blowup.
    week = [{"Subject": "Late", "Created": "2026-08-06T20:00:00Z"}]
    line, long_gaps = R._delay_profile(started, week)
    if "7d 0h (>5m)" not in line or long_gaps != 1:
        failures.append(f"week-long gap formatting: {line}")

    for f in failures:
        print(f"FAIL  {f}")
    return failures


def test_snippets() -> list[str]:
    """Usage snippets: the variable with ±10 words of surrounding email text."""
    failures = []
    long_body = (
        "<p>one two three four five six seven eight nine ten eleven twelve "
        "{{customer.first_name}} a b c d e f g h i j k l m</p>"
    )
    snip = _liquid_ref_snippets([{"type": "email", "subject": "", "body": long_body, "body_plain": ""}])
    ctx = snip["customer"]["first_name"][0]["context"]
    if not ctx.startswith("… three four"):
        failures.append(f"10-word window with leading ellipsis: {ctx}")
    if "{{customer.first_name}}" not in ctx:
        failures.append(f"the variable itself must appear: {ctx}")
    if not ctx.endswith("j …"):
        failures.append(f"10 words after with trailing ellipsis: {ctx}")
    if "<p>" in ctx:
        failures.append("HTML must be stripped when body_plain is empty")

    # Short surroundings: no ellipses; subject used as the email label.
    snip = _liquid_ref_snippets(
        [{"type": "email", "subject": "Hi {{trigger.name}}!", "body_plain": "welcome aboard"}]
    )
    row = snip["trigger"]["name"][0]
    if row["email"] != "Hi {{trigger.name}}!":
        failures.append(f"subject label: {row}")
    if "…" in row["context"]:
        failures.append(f"short text must carry no ellipses: {row}")

    for f in failures:
        print(f"FAIL  {f}")
    return failures


def main() -> int:
    failures = test_static_refs() + test_runtime_content() + test_delay_profile() + test_snippets()
    print("FAILED" if failures else "static and runtime variable checks behave correctly")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
