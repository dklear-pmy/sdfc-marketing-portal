"""Mirror test: the rep-phone null guard must survive in every copy.

The membership candidate SQL lives in three places — the hub's triggers.py
(the copy that actually sends) and the two files under api/sql (the live
preview view and the parameterized replay variant). CIO rejects a Send Event
outright when a trigger variable is null, so any copy that loses the guard
silently reintroduces the member losses of 2026-08-25.

Plain asserts, no pytest, no credentials — this only reads the .sql files.
"""

from pathlib import Path

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"

# Both files carry the membership candidate CTEs (account owner + deal
# closer), so both must keep the guard in both places.
MIRRORED = ("vw_campaign_would_fire.sql", "tf_campaign_would_fire_history.sql")


def test_rep_phone_guard_present_in_every_mirror():
    """DRIFT WARNING: keep in step with the hub's triggers.py, which is the
    copy that actually builds the outbound payload."""
    for name in MIRRORED:
        sql = (SQL_DIR / name).read_text()
        assert sql.count("COALESCE(NULLIF(NULLIF(phone, 'None'), '')") == 2, name
        assert sql.count("NULLIF(NULLIF(mobile_phone, 'None'), '')") == 2, name


def test_no_bare_null_phone_survives():
    """The exact pre-fix expression must not reappear in any copy."""
    for name in MIRRORED:
        sql = (SQL_DIR / name).read_text()
        assert "'')        AS phone" not in sql, name


# The signup trigger's exactly-once grain is the PERSON. Keyed on the TB
# activity_id until 2026-08-27, a fan who submitted a form twice was welcomed
# twice (four fans got "Email 1" twice overnight 08-26/27). All three copies
# must key on LOWER(f.email) and collapse each batch to one row per person.
SIGNUP_KEY = "LOWER(f.email)                                         AS dedup_key"
SIGNUP_OLD_KEY = "CAST(a.activity_id AS STRING)                          AS dedup_key"


def test_signup_keyed_on_person_in_every_mirror():
    """DRIFT WARNING: keep in step with the hub's triggers.py."""
    for name in MIRRORED:
        sql = (SQL_DIR / name).read_text()
        assert SIGNUP_KEY in sql, name
        assert SIGNUP_OLD_KEY not in sql, name
        assert "PARTITION BY LOWER(f.email)" in sql, name
        assert "ORDER BY a.activity_ts DESC NULLS LAST, a.activity_id DESC" in sql, name


# welcome_shopify_260715 (spec 2026-09-03): first Shopify purchase, no ticket
# history. Both copies must carry the hub's decisions — refunded/voided are
# not purchases, staff are excluded, attendance counts as ticket history, and
# names are blank-not-null (CIO rejects a Send Event with a NULL variable).
SHOPIFY_PINS = (
    "financial_status NOT IN ('REFUNDED', 'VOIDED')",
    r"r'@(sandiegofc\.com|pmygroup\.com)$'",
    "IFNULL(v.ticket_seats_purchased, 0) = 0",
    "IFNULL(v.has_season_plan, FALSE) = FALSE",
    "IFNULL(v.matches_attended_lifetime, 0) = 0",
    "COALESCE(v.first_name, '')",
    "COALESCE(v.last_name, '')",
)
# The Aug-6 draft: counted refunds as purchases and selected only people the
# warehouse had never seen — a different, far narrower population.
SHOPIFY_OLD = "financial_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')"


def test_shopify_mirrors_the_hub():
    """DRIFT WARNING: keep in step with the hub's triggers.py."""
    for name in MIRRORED:
        sql = (SQL_DIR / name).read_text()
        for pin in SHOPIFY_PINS:
            assert pin in sql, (name, pin)
        assert SHOPIFY_OLD not in sql, name


if __name__ == "__main__":
    for _name, _fn in list(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print(f"ok  {_name}")
