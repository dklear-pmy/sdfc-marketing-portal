"""Tripwire accounts: persistent @qa.sdfc.dev profiles that live in Customer.io,
receive real sends into the Mailpit sink, and are asserted on a 5-minute
Cloud Scheduler tick (plus on-demand runs from the portal).

Two kinds (the `kind` column), deliberately simple:

  guard_sub / guard_unsub — TWO fixed dummy accounts watching only the
    subscription flags, one per direction. The subscribed guard catches
    mass-suppression; the unsubscribed guard catches the July-class
    resubscribe loop AND any mail sent after its opt-out (suppression).
    They are workspace fixtures, not per-campaign config.

  campaign — accounts planted in a specific journey's audience (provisioned
    through the slug's test webhook). They prove the campaign keeps working:
    mail keeps arriving, sends get delivered, deliveries reach the sink.

Checks by kind (each isolated — a thrown check records WARN, never aborts):
  profile_exists  — all kinds: the CIO profile is still there
  subscription    — all kinds: unsubscribed flag matches the kind's polarity
  suppression     — guard_unsub: any send AFTER the opt-out moment means
                    suppression is not being respected
  guard_conversion— guard_unsub, transitional: provisioned but hasn't received
                    the email needed for its one-click unsubscribe yet; the
                    tick converts it
  transport       — campaign: anything sent in the last 24h was delivered
                    within 15 min (the scenario-005 sent-but-undelivered class)
  sink_arrival    — campaign: every delivery CIO claims in the last 24h is in
                    the Mailpit sink (catches sink/MX drift from the other end)
  quiet           — campaign, optional: warn after max_quiet_days of silence

Workspace-level check (recorded under email='_workspace'):
  pmy_test_lint   — no non-PMY-TEST campaign triggers on a pmy_test_* event

Alerts are reserved for the system not operating — the canary and the
delivery/suppression checks above. Configuration findings (CONFIG_CHECKS, e.g.
pmy_test_lint) are recorded and surfaced on the Tripwires page, but never
emailed: nothing is failing at runtime, so paging people hourly trains them to
ignore the channel that should mean an outage.

Registry + results live in `customerio_state.tripwires` / `tripwire_checks`
(portal-sa is dataset WRITER). Provisioning fires a slug's TEST webhook, the
same proven path the harness runner uses. Deleting is always soft — a
deleted_at tombstone hides the row and stops checks, restore brings it back;
check history and the CIO profile are never destroyed.
"""

import datetime as dt
import json
import time

import requests
from google.cloud import bigquery

from . import emailer, mailpit
from .bqstate import client
from .cio import CioClient
from .config import GCP_PROJECT, PORTAL_BASE_URL, slug_registry
from .runner import _webhook_url

_DATASET = f"{GCP_PROJECT}.customerio_state"

DELIVERY_DEADLINE_MIN = 15
TRANSPORT_WINDOW_H = 24

# ---- synthetic canary ----
# The passive tripwires above only fail when there IS traffic: with nothing sent,
# transport and sink_arrival both return PASS ("no sends in the last 24h"), which
# is an absence of evidence rather than evidence of health. The canary generates
# traffic on a schedule so those PASSes mean something, and so a broken send path
# is caught within the hour instead of whenever a real campaign next runs.
#
# It goes out as a CIO TRANSACTIONAL send, not through a campaign. Verified
# 2026-07-28, in this order, because each one ruled out a simpler design:
#   - re-firing the test welcome webhook produces NO second email (journey
#     re-entry is blocked), so a webhook canary delivers once then goes silent
#     forever — and reads as an infrastructure failure when it does;
#   - the App API cannot delete people (404; that is the Track API), so a
#     rotating-address canary would strand 24 orphan profiles a day;
#   - /v1/send/email accepts an inline subject+body, needs no CIO-side config,
#     is repeatable within seconds, and lands in the ledger marked delivered.
# It also keeps campaign metrics clean, which a campaign-driven canary would not.
CANARY_EMAIL = "canary@qa.sdfc.dev"
CANARY_FROM = "San Diego FC <info@sandiegofc.com>"  # the only verified CIO sender
CANARY_SUBJECT = "SDFC synthetic tripwire"
# Fired hourly; allow a missed run plus clock slop before calling it stale.
CANARY_MAX_AGE_MIN = 75


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(ts: float | None) -> str | None:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat() if ts else None


# ---- registry ----


def list_tripwires(active_only: bool = False, include_deleted: bool = False) -> list[dict]:
    conds = [] if include_deleted else ["deleted_at IS NULL"]
    if active_only:
        conds.append("active")
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = client().query(
        f"SELECT * FROM `{_DATASET}.tripwires` {where} ORDER BY created_at"
    ).result()
    out = []
    for r in rows:
        d = dict(r)
        for f in ("created_at", "unsubscribed_at", "deleted_at"):
            d[f] = d[f].isoformat() if d.get(f) else None
        out.append(d)
    return out


_SENTINEL = object()


def update_tripwire(
    email: str,
    *,
    label: str | None = None,
    purpose: str | None = None,
    expect_subscribed: bool | None = None,
    max_quiet_days: int | None | object = _SENTINEL,
    active: bool | None = None,
) -> dict:
    """Edit a registered tripwire. Only supplied fields change.

    max_quiet_days uses a sentinel rather than None as "leave alone", because
    None is a MEANINGFUL value here — it disables the quiet check entirely, and
    a tripwire with no quiet threshold cannot report that it has gone silent.
    """
    email = email.strip().lower()
    if not any(t["email"] == email for t in list_tripwires()):
        raise ValueError(f"{email} is not registered")

    sets, params = [], [bigquery.ScalarQueryParameter("email", "STRING", email)]
    for name, value, sql_type in (
        ("label", label, "STRING"),
        ("purpose", purpose, "STRING"),
        ("expect_subscribed", expect_subscribed, "BOOL"),
        ("active", active, "BOOL"),
    ):
        if value is not None:
            sets.append(f"{name} = @{name}")
            params.append(bigquery.ScalarQueryParameter(name, sql_type, value))
    if max_quiet_days is not _SENTINEL:
        sets.append("max_quiet_days = @quiet")
        params.append(bigquery.ScalarQueryParameter("quiet", "INT64", max_quiet_days))
    if not sets:
        raise ValueError("Nothing to update")

    client().query(
        f"UPDATE `{_DATASET}.tripwires` SET {', '.join(sets)} WHERE email = @email",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    return next(t for t in list_tripwires() if t["email"] == email)


def add_tripwire(
    email: str,
    label: str,
    purpose: str | None,
    *,
    expect_subscribed: bool = True,
    max_quiet_days: int | None = None,
    provision_slug: str | None = None,
    actor: str | None = None,
) -> dict:
    email = email.strip().lower()
    if not email.endswith("@qa.sdfc.dev"):
        raise ValueError("Tripwire emails must be @qa.sdfc.dev (the sink only accepts that domain)")
    existing = {t["email"]: t for t in list_tripwires(include_deleted=True)}
    if email in existing:
        if existing[email].get("deleted_at"):
            raise ValueError(f"{email} was soft-deleted — restore it instead of re-adding")
        raise ValueError(f"{email} is already registered")

    provisioned = None
    if provision_slug:
        spec = slug_registry().get(provision_slug)
        if not spec or not (spec.get("test_webhook_url") or spec.get("test_webhook_secret")):
            raise ValueError(f"slug '{provision_slug}' has no test webhook to provision through")
        payload = _provision_payload(email, label)
        resp = requests.post(_webhook_url(spec), json=payload, timeout=20)
        if resp.status_code not in (200, 202):
            raise ValueError(f"provisioning webhook HTTP {resp.status_code}: {resp.text[:150]}")
        provisioned = f"webhook HTTP {resp.status_code} via {provision_slug}"

    client().query(
        f"""
        INSERT INTO `{_DATASET}.tripwires`
          (email, label, purpose, expect_subscribed, max_quiet_days, active, created_at,
           created_by, provision_slug, guard_pending, kind)
        VALUES (@email, @label, @purpose, @expect_sub, @quiet, TRUE, CURRENT_TIMESTAMP(),
                @actor, @slug, FALSE, 'campaign')
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("email", "STRING", email),
                bigquery.ScalarQueryParameter("label", "STRING", label),
                bigquery.ScalarQueryParameter("purpose", "STRING", purpose),
                bigquery.ScalarQueryParameter("expect_sub", "BOOL", expect_subscribed),
                bigquery.ScalarQueryParameter("quiet", "INT64", max_quiet_days),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
                bigquery.ScalarQueryParameter("slug", "STRING", provision_slug),
            ]
        ),
    ).result()
    return {"email": email, "provisioned": provisioned}


def _provision_payload(email: str, label: str) -> dict:
    """tb_signup-shaped payload; dedup key derives from the local-part hash so
    re-provisioning the same tripwire is idempotent on CIO's side."""
    now = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    activity_id = 980000000 + (abs(hash(email)) % 1000000)
    return {
        "dedup_key": str(activity_id),
        "email": email,
        "activity_id": activity_id,
        "campaign_title": "San Diego FC / Stay Informed",
        "signup_form_family": "stay_informed",
        "is_world_cup": False,
        "is_new_fan_24h": True,
        "fan_created_at": now,
        "activity_at": now,
        "first_name": "Tripwire",
        "last_name": label,
        "fan_source": "",
        "phone_subscribed": False,
        "has_season_plan": False,
        "postal_code": "92101",
    }


def make_resub_guard(email: str) -> dict:
    """Turn a provisioned tripwire into a resubscribe guard: fire the one-click
    unsubscribe from its newest sink message (the genuine fan-facing path — no
    Track API credentials involved), confirm Customer.io recorded the flip,
    then expect unsubscribed from here on. The subscription check on the
    5-minute tick alerts the moment anything re-subscribes the account — the
    inverse failure mode of the July unsub-loop, which was mass RE-subscription
    of people who had opted out.
    """
    email = email.strip().lower()
    if not any(t["email"] == email for t in list_tripwires()):
        raise ValueError(f"{email} is not a registered tripwire")

    url = None
    for m in sorted(mailpit.search_to(email), key=lambda m: m.get("Created", ""), reverse=True):
        url = mailpit.unsubscribe_url(mailpit.raw_message(m["ID"]))
        if url:
            break
    if not url:
        raise ValueError(
            "No List-Unsubscribe link in this tripwire's sink messages — provision it and let a welcome email arrive first"
        )

    resp = requests.post(url, data={"List-Unsubscribe": "One-Click"}, timeout=20)
    if resp.status_code >= 400:
        raise ValueError(f"One-click unsubscribe returned HTTP {resp.status_code}")

    cio = CioClient()
    confirmed = False
    for _ in range(6):
        person = cio.customer_by_email(email)
        if person and bool(cio.customer_attributes(person["cio_id"]).get("unsubscribed")):
            confirmed = True
            break
        time.sleep(5)
    if not confirmed:
        raise ValueError(
            "Unsubscribe fired but Customer.io hasn't recorded unsubscribed=true yet — retry in a minute"
        )

    # unsubscribed_at anchors the suppression check: sends after this moment
    # mean CIO (or something upstream) is mailing an opted-out person.
    client().query(
        f"UPDATE `{_DATASET}.tripwires` SET expect_subscribed = FALSE, guard_pending = FALSE, "
        "unsubscribed_at = CURRENT_TIMESTAMP() WHERE email = @email",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", email)]
        ),
    ).result()
    return {"email": email, "unsubscribed": True, "expect_subscribed": False}


def delete_tripwire(email: str) -> dict:
    """Soft delete: tombstone + deactivate. Checks stop, the row leaves the
    default listing, and the CIO profile plus check history stay untouched."""
    email = email.strip().lower()
    if not any(t["email"] == email for t in list_tripwires()):
        raise ValueError(f"{email} is not a registered tripwire (or is already deleted)")
    client().query(
        f"UPDATE `{_DATASET}.tripwires` SET deleted_at = CURRENT_TIMESTAMP(), active = FALSE "
        "WHERE email = @email",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", email)]
        ),
    ).result()
    return {"email": email, "deleted": True}


def restore_tripwire(email: str) -> dict:
    email = email.strip().lower()
    rows = {t["email"]: t for t in list_tripwires(include_deleted=True)}
    if email not in rows:
        raise ValueError(f"{email} is not a registered tripwire")
    if not rows[email].get("deleted_at"):
        raise ValueError(f"{email} is not deleted")
    client().query(
        f"UPDATE `{_DATASET}.tripwires` SET deleted_at = NULL, active = TRUE WHERE email = @email",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", email)]
        ),
    ).result()
    return {"email": email, "restored": True}


# ---- checks ----


def _check_profile(cio: CioClient, email: str) -> tuple[dict | None, dict]:
    person = cio.customer_by_email(email)
    if not person:
        return None, {"check_name": "profile_exists", "status": "FAIL", "detail": "No CIO profile for this email"}
    return person, {"check_name": "profile_exists", "status": "PASS", "detail": f"cio_id {person['cio_id']}"}


def _check_subscription(cio: CioClient, cio_id: str, expect_subscribed: bool) -> dict:
    customer = cio.customer_attributes(cio_id)
    unsub = bool(customer.get("unsubscribed"))
    ok = unsub != expect_subscribed
    if ok:
        return {"check_name": "subscription", "status": "PASS", "detail": "unsubscribed=false as expected" if expect_subscribed else "unsubscribed=true as expected"}
    if expect_subscribed:
        detail = "Profile is UNSUBSCRIBED but should be subscribed — suppression/unsub-loop event or import overwrote it"
    else:
        detail = "Profile is subscribed but should be unsubscribed"
    return {"check_name": "subscription", "status": "FAIL", "detail": detail}


def _check_transport(messages: list[dict]) -> dict:
    cutoff = _now().timestamp() - TRANSPORT_WINDOW_H * 3600
    recent = [m for m in messages if (m.get("metrics") or {}).get("sent", 0) >= cutoff]
    if not recent:
        return {"check_name": "transport", "status": "PASS", "detail": f"No sends in the last {TRANSPORT_WINDOW_H}h"}
    lost = []
    for m in recent:
        mt = m.get("metrics") or {}
        overdue = _now().timestamp() - mt["sent"] > DELIVERY_DEADLINE_MIN * 60
        if not mt.get("delivered") and not mt.get("bounced") and overdue:
            lost.append(f"'{m.get('subject')}' sent {_iso(mt['sent'])}")
    if lost:
        return {
            "check_name": "transport",
            "status": "FAIL",
            "detail": f"Sent but never delivered (> {DELIVERY_DEADLINE_MIN} min, no bounce): " + "; ".join(lost[:3]),
        }
    return {"check_name": "transport", "status": "PASS", "detail": f"{len(recent)} send(s) in {TRANSPORT_WINDOW_H}h — none lost"}


def _check_sink_arrival(email: str, messages: list[dict]) -> dict:
    cutoff = _now().timestamp() - TRANSPORT_WINDOW_H * 3600
    delivered = [
        m for m in messages if (m.get("metrics") or {}).get("delivered", 0) >= cutoff
    ]
    if not delivered:
        return {"check_name": "sink_arrival", "status": "PASS", "detail": f"No deliveries in the last {TRANSPORT_WINDOW_H}h"}
    sink_subjects = {m.get("Subject") for m in mailpit.search_to(email)}
    missing = [m.get("subject") for m in delivered if m.get("subject") not in sink_subjects]
    if missing:
        return {
            "check_name": "sink_arrival",
            "status": "FAIL",
            "detail": "CIO says delivered but not in the sink: " + "; ".join(f"'{s}'" for s in missing[:3]),
        }
    return {"check_name": "sink_arrival", "status": "PASS", "detail": f"all {len(delivered)} deliveries present in the sink"}


GUARD_CONVERT_GRACE_H = 2
SUPPRESSION_GRACE_MIN = 5


def _pending_row(created_at: str | None, error: str) -> dict:
    """A guard that cannot convert yet is normal minutes after provisioning
    (its first email hasn't arrived); hours later the journey never delivered
    and the operator needs to see it."""
    age_h = None
    if created_at:
        age_h = (_now() - dt.datetime.fromisoformat(created_at)).total_seconds() / 3600
    if age_h is not None and age_h < GUARD_CONVERT_GRACE_H:
        return {
            "check_name": "guard_conversion",
            "status": "PASS",
            "detail": f"Waiting for its first email before unsubscribing ({int(age_h * 60)}m since provisioning)",
        }
    return {"check_name": "guard_conversion", "status": "WARN", "detail": f"Still not converted: {error[:140]}"}


def _check_suppression(messages: list[dict], unsubscribed_at: str) -> dict:
    """The inverse of transport: an unsubscribed account must STOP receiving.
    Any send after the opt-out moment (plus a small grace for in-flight mail)
    means suppression is not being respected — the compliance half of what an
    opt-out guard exists to catch."""
    optout_ts = dt.datetime.fromisoformat(unsubscribed_at).timestamp()
    cutoff = optout_ts + SUPPRESSION_GRACE_MIN * 60
    late = [m for m in messages if ((m.get("metrics") or {}).get("sent") or 0) > cutoff]
    if late:
        subjects = "; ".join(f"'{m.get('subject')}'" for m in late[:3])
        return {
            "check_name": "suppression",
            "status": "FAIL",
            "detail": f"{len(late)} send(s) AFTER this account opted out — suppression not respected: {subjects}",
        }
    return {
        "check_name": "suppression",
        "status": "PASS",
        "detail": f"No sends since opt-out ({_humanize_dur(_now().timestamp() - optout_ts)} ago)",
    }


def _check_quiet(messages: list[dict], max_quiet_days: int | None) -> dict | None:
    if not max_quiet_days:
        return None
    last_sent = max(((m.get("metrics") or {}).get("sent") or 0 for m in messages), default=0)
    if not last_sent:
        return {"check_name": "quiet", "status": "WARN", "detail": "Never received a send"}
    days = (_now().timestamp() - last_sent) / 86400
    if days > max_quiet_days:
        return {
            "check_name": "quiet",
            "status": "WARN",
            "detail": f"No sends for {days:.1f}d (threshold {max_quiet_days}d) — audience drift or genuinely quiet period",
        }
    return {"check_name": "quiet", "status": "PASS", "detail": f"Last send {days:.1f}d ago (threshold {max_quiet_days}d)"}


# ---- alert class ----
# An email means "the system is not operating" — the canary stopped getting
# through, a real send went missing, an unsubscribe wasn't honored. A campaign
# wired wrong is a different animal: nothing is broken at runtime, someone has
# work to do, and it belongs on the Tripwires page where they'll see it in
# context. Config findings are still recorded and still turn the workspace
# card red; they just never page anyone. Add future lint-style checks here.
CONFIG_CHECKS = frozenset({"pmy_test_lint"})


def is_config_finding(row: dict) -> bool:
    return row.get("check_name") in CONFIG_CHECKS


def alertable(results: list[dict]) -> list[dict]:
    """The failures that are allowed to page someone: runtime failures only.

    A config finding is still a FAIL in the record and still reddens its card;
    it just isn't an outage, so it never reaches the emailer.
    """
    return [r for r in results if r["status"] == "FAIL" and not is_config_finding(r)]


def _check_workspace_lint(cio: CioClient) -> dict:
    campaigns = cio.campaigns()
    offenders = [
        f"{c.get('name')} (id {c.get('id')}, {c.get('state')})"
        for c in campaigns
        if (c.get("event_name") or "").startswith("pmy_test_")
        and "PMY-TEST" not in (c.get("name") or "")
    ]
    if offenders:
        return {
            "check_name": "pmy_test_lint",
            "status": "FAIL",
            "detail": "Non-PMY-TEST campaign(s) triggering on pmy_test_* events: " + "; ".join(offenders[:3]),
        }
    return {"check_name": "pmy_test_lint", "status": "PASS", "detail": f"{len(campaigns)} campaigns checked — no live campaign listens on pmy_test_* events"}


def send_canary() -> dict:
    """Fire one synthetic send. Called hourly by Cloud Scheduler, or by hand."""
    cio = CioClient()
    stamp = _now().strftime("%Y-%m-%d %H:%M UTC")
    resp = cio.session.post(
        f"{cio.base}/send/email",
        json={
            "to": CANARY_EMAIL,
            "identifiers": {"email": CANARY_EMAIL},
            "from": CANARY_FROM,
            "subject": f"{CANARY_SUBJECT} {stamp}",
            "body": (
                "<p>Synthetic tripwire email from the SDFC marketing portal. "
                "Not a fan-facing email — it proves the Customer.io send path and "
                "the test inbox are working, and that these checks are running.</p>"
            ),
        },
        timeout=25,
    )
    if resp.status_code >= 300:
        raise RuntimeError(f"canary send failed: HTTP {resp.status_code} {resp.text[:200]}")
    return {"sent_at": _now().isoformat(), "delivery_id": resp.json().get("delivery_id")}


def _check_canary(cio: CioClient) -> list[dict]:
    """Liveness AND correctness in one place: a canary that never fired is as
    much a failure as one that fired and never arrived."""
    messages = [
        m
        for m in cio.messages_for_recipient(CANARY_EMAIL, limit=50)
        if (m.get("metrics") or {}).get("sent")
    ]
    if not messages:
        return [{
            "check_name": "canary_send",
            "status": "FAIL",
            "detail": f"No tripwire send has ever reached {CANARY_EMAIL}",
        }]

    latest = max(messages, key=lambda m: m["metrics"]["sent"])
    sent = latest["metrics"]["sent"]
    age_min = (_now().timestamp() - sent) / 60
    rows: list[dict] = []

    if age_min > CANARY_MAX_AGE_MIN:
        # Nothing is firing the canary — so every quiet PASS elsewhere in this
        # run is unverified, which is exactly what the canary exists to reveal.
        rows.append({
            "check_name": "canary_send",
            "status": "FAIL",
            "detail": (
                f"Last tripwire send {age_min / 60:.1f}h ago (expected hourly) — the send job "
                "is not firing, so quiet PASSes elsewhere prove nothing"
            ),
        })
    else:
        rows.append({
            "check_name": "canary_send",
            "status": "PASS",
            "detail": f"Last tripwire send {int(age_min)}m ago",
        })

    mt = latest["metrics"]
    if mt.get("delivered"):
        lag = (mt["delivered"] - sent) / 60
        rows.append({
            "check_name": "canary_delivery",
            "status": "PASS",
            "detail": f"Delivered {lag:.1f} min after send",
        })
    elif mt.get("bounced"):
        rows.append({
            "check_name": "canary_delivery",
            "status": "FAIL",
            "detail": f"Tripwire send BOUNCED (sent {_iso(sent)})",
        })
    elif age_min > DELIVERY_DEADLINE_MIN:
        rows.append({
            "check_name": "canary_delivery",
            "status": "FAIL",
            "detail": f"Sent {int(age_min)}m ago, still not delivered or bounced",
        })
    else:
        # Inside the grace window a pending send is normal, not a finding.
        rows.append({
            "check_name": "canary_delivery",
            "status": "PASS",
            "detail": f"In flight ({int(age_min)}m, deadline {DELIVERY_DEADLINE_MIN}m)",
        })

    if mt.get("delivered"):
        # Guarded on its own: an unreachable sink must not also discard the send
        # and delivery findings above, which are the more important two. (Local
        # dev always lands here — user ADC cannot mint an IAP token for Mailpit.)
        try:
            subjects = {m.get("Subject") for m in mailpit.search_to(CANARY_EMAIL)}
        except Exception as e:  # noqa: BLE001
            rows.append({
                "check_name": "canary_sink",
                "status": "WARN",
                "detail": f"sink unreachable: {str(e)[:150]}",
            })
        else:
            if latest.get("subject") in subjects:
                rows.append({
                    "check_name": "canary_sink",
                    "status": "PASS",
                    "detail": "Latest tripwire send present in the test inbox",
                })
            else:
                rows.append({
                    "check_name": "canary_sink",
                    "status": "FAIL",
                    "detail": f"CIO delivered {latest.get('subject')!r} but it is not in the sink",
                })
    return rows


def _guard(fn, *args, check_name: str) -> dict:
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 — a broken dependency must read as WARN, not abort the tick
        return {"check_name": check_name, "status": "WARN", "detail": f"check could not run: {str(e)[:180]}"}


def run_checks(source: str) -> dict:
    cio = CioClient()
    results: list[dict] = []

    for tw in list_tripwires(active_only=True):
        email = tw["email"]
        kind = tw.get("kind") or "campaign"
        rows: list[dict] = []
        # profile check returns a tuple, so it gets its own guard inline
        try:
            person, profile_check = _check_profile(cio, email)
        except Exception as e:  # noqa: BLE001
            person, profile_check = None, {
                "check_name": "profile_exists", "status": "WARN", "detail": f"check could not run: {str(e)[:180]}"
            }
        rows.append(profile_check)

        if person and kind == "guard_unsub" and tw.get("guard_pending"):
            # A fresh unsubscribed guard waiting on its first email: try the
            # conversion each tick until the one-click unsubscribe lands.
            try:
                make_resub_guard(email)
            except ValueError as e:
                rows.append(_pending_row(tw.get("created_at"), str(e)))
            except Exception as e:  # noqa: BLE001
                rows.append({"check_name": "guard_conversion", "status": "WARN", "detail": f"conversion attempt failed: {str(e)[:150]}"})
            else:
                tw = {**tw, "expect_subscribed": False, "guard_pending": False, "unsubscribed_at": _now().isoformat()}
                rows.append({"check_name": "guard_conversion", "status": "PASS", "detail": "Converted — unsubscribed via its own one-click link; now expects unsubscribed"})

        if person:
            rows.append(_guard(_check_subscription, cio, person["cio_id"], tw["expect_subscribed"], check_name="subscription"))
            # The subscribed guard only watches its flag — no message-based
            # checks, so it stays a two-line fixture.
            wants_suppression = kind == "guard_unsub" and tw.get("unsubscribed_at")
            if kind == "campaign" or wants_suppression:
                try:
                    messages = cio.customer_messages_page(person["cio_id"], limit=50).get("messages", [])
                except Exception as e:  # noqa: BLE001
                    warn_as = "transport" if kind == "campaign" else "suppression"
                    rows.append({"check_name": warn_as, "status": "WARN", "detail": f"delivery ledger unavailable: {str(e)[:150]}"})
                else:
                    if wants_suppression:
                        rows.append(_guard(_check_suppression, messages, tw["unsubscribed_at"], check_name="suppression"))
                    if kind == "campaign":
                        rows.append(_guard(_check_transport, messages, check_name="transport"))
                        rows.append(_guard(_check_sink_arrival, email, messages, check_name="sink_arrival"))
                        quiet = _guard(_check_quiet, messages, tw["max_quiet_days"], check_name="quiet")
                        if quiet:
                            rows.append(quiet)

        for r in rows:
            r["email"] = email
        results.extend(rows)

    ws = _guard(_check_workspace_lint, cio, check_name="pmy_test_lint")
    ws["email"] = "_workspace"
    results.append(ws)

    try:
        canary_rows = _check_canary(cio)
    except Exception as e:  # noqa: BLE001 — same contract as _guard, but multi-row
        canary_rows = [{
            "check_name": "canary_send",
            "status": "WARN",
            "detail": f"check could not run: {str(e)[:180]}",
        }]
    for r in canary_rows:
        r["email"] = "_canary"
    results.extend(canary_rows)

    _record(results, source)
    failing = sum(1 for r in results if r["status"] == "FAIL")
    warning = sum(1 for r in results if r["status"] == "WARN")
    config = [r for r in results if r["status"] == "FAIL" and is_config_finding(r)]
    alert = _alerting(alertable(results))

    return {
        "checked_at": _now().isoformat(),
        "checks": len(results),
        "fail": failing,
        "warn": warning,
        # Of the failures above, how many are config findings — recorded and
        # shown in the portal, deliberately not emailed.
        "config_findings": len(config),
        "alert": alert,
        "results": results,
    }


# ---- alert policy: immediate on new/changed failures, hourly reminders
# ---- until resolved, one recovery email when clear. State survives Cloud Run
# ---- instance churn in customerio_state.tripwire_alert_state.

REMINDER_MINUTES = 60
_PORTAL_LINK = f"{PORTAL_BASE_URL}/tripwires"


def _humanize_dur(seconds: float) -> str:
    m = int(seconds // 60)
    if m < 60:
        return f"{m}m"
    h, m = divmod(m, 60)
    if h < 48:
        return f"{h}h {m:02d}m"
    return f"{h // 24}d {h % 24}h"


def _decide(cur: set[str], state: dict | None, now: dt.datetime) -> tuple[str | None, dict | None]:
    """Pure decision: (email_kind, new_state). Kinds: new/changed/reminder/
    recovery/None. new_state None clears the stored state."""
    prev = set((state or {}).get("failures") or [])
    if not cur:
        return ("recovery" if prev else None), None
    since = (state or {}).get("failing_since") if prev else None
    since = since or now
    last = (state or {}).get("last_alert_at")
    if cur != prev:
        kind = "new" if not prev else "changed"
        return kind, {"failures": sorted(cur), "failing_since": since, "last_alert_at": now}
    if last is None or (now - last).total_seconds() >= REMINDER_MINUTES * 60:
        return "reminder", {"failures": sorted(cur), "failing_since": since, "last_alert_at": now}
    return None, {"failures": sorted(cur), "failing_since": since, "last_alert_at": last}


def _load_alert_state() -> dict | None:
    rows = list(
        client()
        .query(
            f"SELECT failures_json, failing_since, last_alert_at "
            f"FROM `{_DATASET}.tripwire_alert_state` WHERE id = 'current'"
        )
        .result()
    )
    if not rows:
        return None
    r = rows[0]
    return {
        "failures": json.loads(r.failures_json or "[]"),
        "failing_since": r.failing_since,
        "last_alert_at": r.last_alert_at,
    }


def _save_alert_state(state: dict | None) -> None:
    if state is None:
        client().query(
            f"DELETE FROM `{_DATASET}.tripwire_alert_state` WHERE id = 'current'"
        ).result()
        return
    client().query(
        f"""
        MERGE `{_DATASET}.tripwire_alert_state` t USING (SELECT 'current' AS id) s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET failures_json = @f, failing_since = @since,
          last_alert_at = @last, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (id, failures_json, failing_since, last_alert_at, updated_at)
          VALUES ('current', @f, @since, @last, CURRENT_TIMESTAMP())
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("f", "STRING", json.dumps(state["failures"])),
                bigquery.ScalarQueryParameter("since", "TIMESTAMP", state["failing_since"]),
                bigquery.ScalarQueryParameter("last", "TIMESTAMP", state["last_alert_at"]),
            ]
        ),
    ).result()


def _alerting(fails: list[dict]) -> dict | None:
    now = _now()
    cur = {f"{r['email']}·{r['check_name']}" for r in fails}
    try:
        state = _load_alert_state()
        kind, new_state = _decide(cur, state, now)
        alert: dict | None = None
        if kind:
            lines = "\n".join(f"- {r['email']} · {r['check_name']}: {r['detail']}" for r in fails)
            n = len(fails)
            plural = "s" if n > 1 else ""
            if kind == "recovery":
                dur = (
                    _humanize_dur((now - state["failing_since"]).total_seconds())
                    if state and state.get("failing_since")
                    else "?"
                )
                subj = "[Tripwires] Resolved — all clear"
                body = f"All tripwire checks are passing again (outage lasted {dur}).\n\n{_PORTAL_LINK}"
            elif kind == "reminder":
                dur = _humanize_dur((now - new_state["failing_since"]).total_seconds())
                subj = f"[Tripwires] STILL FAILING after {dur}: {n} check{plural}"
                body = (
                    f"Unresolved for {dur} — hourly reminders continue until fixed:\n\n"
                    f"{lines}\n\n{_PORTAL_LINK}"
                )
            else:
                prev = set((state or {}).get("failures") or [])
                subj = f"[Tripwires] {n} failing check{plural}"
                delta = ""
                if kind == "changed":
                    newly, cleared = sorted(cur - prev), sorted(prev - cur)
                    if newly:
                        delta += "\nNew since last alert: " + ", ".join(newly)
                    if cleared:
                        delta += "\nNo longer failing: " + ", ".join(cleared)
                body = (
                    "Failing now (checks run every 5 minutes; reminders hourly until "
                    f"resolved):\n\n{lines}{delta}\n\n{_PORTAL_LINK}"
                )
            sent = emailer.send_alert(subj, body)
            alert = {"kind": kind, **sent}
            if not sent["sent"]:
                # keep the alarm armed so the next 5-minute run retries this email
                if new_state is not None:
                    new_state = {**new_state, "last_alert_at": (state or {}).get("last_alert_at")}
                else:
                    new_state = state

        prev_failures = sorted((state or {}).get("failures") or [])
        if new_state is None:
            if state is not None:
                _save_alert_state(None)
        elif (
            state is None
            or new_state["failures"] != prev_failures
            or new_state.get("last_alert_at") != (state or {}).get("last_alert_at")
        ):
            _save_alert_state(new_state)
        return alert
    except Exception as e:  # noqa: BLE001 — alerting must never break the tick
        return {"kind": "error", "sent": False, "detail": f"alerting failed: {str(e)[:150]}"}


def _record(results: list[dict], source: str) -> None:
    if not results:
        return
    stamp = _now().isoformat()  # one timestamp per run, so a run groups cleanly
    rows = [
        {
            "checked_at": stamp,
            "email": r["email"],
            "check_name": r["check_name"],
            "status": r["status"],
            "detail": r.get("detail"),
            "source": source,
        }
        for r in results
    ]
    errors = client().insert_rows_json(f"{_DATASET}.tripwire_checks", rows)
    if errors:
        raise RuntimeError(f"tripwire_checks insert failed: {errors}")


# ---- read side ----

_RANK = {"FAIL": 0, "WARN": 1, "PASS": 2}


def state() -> dict:
    all_rows = list_tripwires(include_deleted=True)
    tripwires = [t for t in all_rows if not t.get("deleted_at")]
    deleted = [t for t in all_rows if t.get("deleted_at")]
    latest = list(
        client()
        .query(
            # Latest row per check, but only checks that were part of the
            # account's NEWEST run — otherwise a check retired by a config
            # change (e.g. a guard that no longer runs transport) would show
            # its stale last result forever. The 2-minute window absorbs
            # pre-2026-07-29 runs that stamped each row individually.
            f"""
            SELECT email, check_name, status, detail, checked_at FROM (
              SELECT *,
                     ROW_NUMBER() OVER (PARTITION BY email, check_name ORDER BY checked_at DESC) rn,
                     MAX(checked_at) OVER (PARTITION BY email) newest
              FROM `{_DATASET}.tripwire_checks`
            ) WHERE rn = 1 AND checked_at >= TIMESTAMP_SUB(newest, INTERVAL 2 MINUTE)
            """
        )
        .result()
    )
    by_email: dict[str, list[dict]] = {}
    last_run = None
    for r in latest:
        d = dict(r)
        d["checked_at"] = d["checked_at"].isoformat()
        by_email.setdefault(d.pop("email"), []).append(d)
        last_run = max(last_run or d["checked_at"], d["checked_at"])

    def overall(checks: list[dict]) -> str:
        return min((c["status"] for c in checks), key=lambda s: _RANK[s]) if checks else "UNCHECKED"

    out = []
    for tw in tripwires:
        checks = sorted(by_email.get(tw["email"], []), key=lambda c: c["check_name"])
        out.append({**tw, "overall": overall(checks) if tw["active"] else "INACTIVE", "checks": checks})

    ws_checks = by_email.get("_workspace", [])
    canary_checks = sorted(by_email.get("_canary", []), key=lambda c: c["check_name"])
    return {
        "tripwires": out,
        "deleted": [{**tw, "overall": "DELETED", "checks": []} for tw in deleted],
        "workspace": {"overall": overall(ws_checks), "checks": ws_checks},
        "canary": {
            "overall": overall(canary_checks),
            "checks": canary_checks,
            "email": CANARY_EMAIL,
        },
        "last_run_at": last_run,
    }


def history(limit: int = 100, email: str | None = None) -> list[dict]:
    limit = max(1, min(limit, 500))
    where, params = "", []
    if email:
        where = "WHERE email = @email"
        params = [bigquery.ScalarQueryParameter("email", "STRING", email)]
    rows = client().query(
        f"""
        SELECT checked_at, email, check_name, status, detail, source
        FROM `{_DATASET}.tripwire_checks` {where}
        ORDER BY checked_at DESC LIMIT {limit}
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    out = []
    for r in rows:
        d = dict(r)
        d["checked_at"] = d["checked_at"].isoformat()
        out.append(d)
    return out
