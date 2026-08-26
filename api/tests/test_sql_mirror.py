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


if __name__ == "__main__":
    for _name, _fn in list(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print(f"ok  {_name}")
