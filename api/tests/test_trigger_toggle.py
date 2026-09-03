"""Pure tests for the trigger-state gate — who may arm real sends, which
triggers can change state at all, and what the portal shows for each stored
value. No credentials."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.affected import (  # noqa: E402
    TRIGGER_CODE_ENABLED,
    TRIGGER_STATES,
    effective_state,
    state_change_error,
)

OPEN = next(k for k, v in TRIGGER_CODE_ENABLED.items() if v)


def test_admin_can_enable_a_code_open_trigger():
    assert state_change_error(OPEN, "enabled", "admin") is None


def test_operator_cannot_enable_but_can_disable_or_draft():
    """Enabling starts real sends — admin only. Disabled and draft are the
    safe directions and stay operator-level, matching the kill switch."""
    status, msg = state_change_error(OPEN, "enabled", "operator")
    assert status == 403 and "admin" in msg
    assert state_change_error(OPEN, "disabled", "operator") is None
    assert state_change_error(OPEN, "draft", "operator") is None


def test_code_closed_trigger_is_locked_at_draft():
    """A placeholder query (WHERE FALSE) is never evaluated by the hub; the
    portal shows it as draft and refuses every change, including to draft.
    Every real trigger has been code-open since shopify's query landed
    (2026-09-03), so the closed case is a synthetic placeholder registered
    for this test only — the gate must still hold for the next one."""
    closed = "_placeholder_where_false"
    TRIGGER_CODE_ENABLED[closed] = False
    try:
        for state in TRIGGER_STATES:
            status, msg = state_change_error(closed, state, "admin")
            assert status == 400 and "draft" in msg, state
        assert effective_state(closed, "enabled") == "draft"
    finally:
        del TRIGGER_CODE_ENABLED[closed]


def test_effective_state_defaults():
    """No row == disabled; unknown stored values read as disabled (never
    enabled); code-open triggers show what is stored."""
    assert effective_state(OPEN, None) == "disabled"
    assert effective_state(OPEN, "bogus") == "disabled"
    for state in TRIGGER_STATES:
        assert effective_state(OPEN, state) == state


def test_unknown_state_is_400():
    status, msg = state_change_error(OPEN, "paused", "admin")
    assert status == 400 and "enabled, disabled, draft" in msg


def test_absorb_is_enable_only():
    """Absorbing writes baseline rows for everyone currently matching — the
    prelude to arming, never a standalone action from this endpoint."""
    for state in ("disabled", "draft"):
        status, msg = state_change_error(OPEN, state, "admin", absorb=True)
        assert status == 400 and "state=enabled" in msg
    assert state_change_error(OPEN, "enabled", "admin", absorb=True) is None
    assert state_change_error(OPEN, "enabled", "operator", absorb=True)[0] == 403


def test_unknown_key_is_404_before_any_role_check():
    assert state_change_error("no_such_trigger_999999", "enabled", "admin") == (
        404, "No such trigger in the hub"
    )


def test_code_gate_mirror_matches_the_hub():
    """All six hub triggers are code-open as of 2026-09-03 (shopify's real
    query replaced the last WHERE FALSE placeholder). DRIFT WARNING: update
    together with triggers.py."""
    assert {k for k, v in TRIGGER_CODE_ENABLED.items() if v} == {
        "tb_signup_260715",
        "welcome_tickets_single_game",
        "welcome_shopify_260715",
        "stm_welcome_tickets_260807",
        "stm_welcome_tickets_supporters_260807",
        "stm_welcome_tickets_premium_260813",
    }
    assert all(TRIGGER_CODE_ENABLED.values()), "no placeholder should remain"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
