# One-time platform setup

Everything here targets GCP/Firebase project **sdfc-udp-dev**.

> **✅ Executed 2026-07-25** — all sections below are DONE except the final DNS
> record and the org-policy decision:
>
> - Firebase was already on the project (409 on addFirebase) and its Auth store
>   is **shared with the scouting sandbox app** (6 users, `role`/`organizationId`
>   claims) → portal claim namespaced `portal_role`, merge-only writes.
> - Hosting: dedicated site **`sdfc-marketing-portal`** (default site
>   `sdfc-udp-dev` belongs to the scouting sandbox — never deploy to it).
>   Web app "SDFC Marketing Portal", Email/Password enabled via Identity Toolkit
>   API (`x-goog-user-project` header needed with user ADC).
> - Custom domain registered via Hosting API; **pending: one Cloudflare record**
>   `CNAME marketing.sdfc.dev → sdfc-marketing-portal.web.app` (DNS-only/grey
>   cloud) — the modern customDomains flow needs no TXT/A records.
> - SAs, scoped IAM, WIF pool/provider, GH variable: all applied as written.
> - **PENDING [console, 30s]: enable Google sign-in provider** (Authentication →
>   Sign-in method → Google → Enable; auto-provisions the OAuth client the API
>   won't create). The login page ships the button already — Google SSO for PMY
>   and SDFC staff, invited email/password for everyone else; `portal_role`
>   stays the gate.
> - **RESOLVED 2026-07-25 (Dean chose DRS exception over API Gateway):**
>   project-level org policy `iam.allowedPolicyMemberDomains` on sdfc-udp-dev
>   set to `allowAll: true` (was inherited allow-list `C03qrfgnt`/`C00ik0b8m`;
>   talent-platform precedent), then `allUsers` → `roles/run.invoker` granted on
>   `marketing-portal-api` ONLY. Auth boundary = Firebase token + `portal_role`
>   on every route; do not grant allUsers on anything else in this project
>   without the same deliberation.

## 1. Firebase

1. **[console]** https://console.firebase.google.com → *Add project* → select
   existing GCP project `sdfc-udp-dev` (Firebase Management API is already
   enabled; this "adds Firebase" to the project without creating a new one).
2. **[console]** Authentication → Sign-in method → enable **Email/Password**.
   Do NOT enable other providers. Settings → User actions → **disable**
   "Enable create (sign-up)" if available on the plan; role claims are the
   real gate either way.
3. **[console]** Project settings → Your apps → *Add app* → Web. Copy the
   `apiKey` into `frontend/.env` (`VITE_FIREBASE_API_KEY`).
4. Hosting init is already committed (`firebase.json`, `.firebaserc`). First
   deploy: `firebase deploy --only hosting --project sdfc-udp-dev`.
5. **[console]** Hosting → *Add custom domain* → `marketing.sdfc.dev`. Firebase
   shows a TXT verification record + A/AAAA records. Create them in Cloudflare
   (zone `sdfc.dev`, account already holds it) as **DNS-only / grey cloud** —
   Firebase must terminate TLS, so do not proxy through Cloudflare.

## 2. Service account for the API

```bash
gcloud iam service-accounts create marketing-portal-sa \
  --project=sdfc-udp-dev --display-name="Marketing portal API"

# CIO credentials + webhook URL secrets
for s in customerio-credentials cio-trigger-url-tb-signup; do
  gcloud secrets add-iam-policy-binding "$s" \
    --project=sdfc-udp-dev \
    --member="serviceAccount:marketing-portal-sa@sdfc-udp-dev.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

```

That is the runtime SA's **entire** Phase-1 grant set: accessor on two named
secrets. Token verification needs no IAM (Firebase public certs). Deliberately
NOT granted: any storage role, any BigQuery role, `firebaseauth.admin`,
project-level anything.

Per-phase additions (grant only when the phase ships):

- **Phase 2 (runner + invites):** `roles/firebaseauth.admin` (invite endpoint
  stamps role claims); `customerio_state` WRITER via **dataset ACL** (NOT a
  project role; project-level `bq add-iam-policy-binding` is allowlist-gated
  anyway); `roles/bigquery.jobUser` (run jobs only — carries no data access);
  IAP-secured Web App User on the Mailpit backend; accessor on further
  `cio-trigger-url-*` secrets as slugs are onboarded.
- **Phase 3 (customer dashboard, executed 2026-07-26):** READER via dataset ACL
  on `customerio_gold` **only** — the lookup does point queries on the email
  clustering key of `fan_attributes` + `fan_attributes_cio_sync` (~15 MB/scan).
  No project-wide `bigquery.dataViewer`, no GCS. Granted with:

  ```python
  # python google-cloud-bigquery, as a project admin
  ds = client.get_dataset("sdfc-udp-dev.customerio_gold")
  ds.access_entries = [*ds.access_entries, bigquery.AccessEntry(
      "READER", "userByEmail",
      "marketing-portal-sa@sdfc-udp-dev.iam.gserviceaccount.com")]
  client.update_dataset(ds, ["access_entries"])
  ```

  Fans list + activity ledger (executed 2026-07-27) added the same dataset-ACL
  READER on `customerdata_silver` (customer_events) and `customerdata_gold`
  (customer_status_ledger). Deliberately NOT granted: `customerio_webhooks` or
  `tradablebits_bronze` — the ledger card reads the hourly-materialized tables,
  not `vw_customer_events_live`, because the live view unions TB *bronze
  externals* whose GCS objects would drag bucket read into this SA.

## 3. CI/CD — Workload Identity Federation (keyless, talent-platform pattern)

`sdfc-udp-dev` has no GitHub WIF pool yet (checked 2026-07-25). Bootstrap:

```bash
gcloud iam workload-identity-pools create github \
  --project=sdfc-udp-dev --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --project=sdfc-udp-dev --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='dklear-pmy/sdfc-marketing-portal'"

gcloud iam service-accounts create github-actions-deployer \
  --project=sdfc-udp-dev --display-name="GitHub Actions deployer"

# Let the repo's workflows impersonate the deployer
gcloud iam service-accounts add-iam-policy-binding \
  github-actions-deployer@sdfc-udp-dev.iam.gserviceaccount.com \
  --project=sdfc-udp-dev \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/133738605371/locations/global/workloadIdentityPools/github/attribute.repository/dklear-pmy/sdfc-marketing-portal"

# Deploy permissions — least privilege. Because this project is the data
# warehouse, the deployer gets NO project-level storage/BQ/artifact roles;
# storage + artifact access are bucket-/repo-scoped below.
DEPLOYER="serviceAccount:github-actions-deployer@sdfc-udp-dev.iam.gserviceaccount.com"

for role in roles/run.admin roles/cloudbuild.builds.editor \
            roles/firebasehosting.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding sdfc-udp-dev --member="$DEPLOYER" --role="$role"
done
# run.admin administers Cloud Run services only (no data access);
# firebasehosting.admin administers Hosting only. Both are product-scoped roles.

# Artifact Registry repo ONLY (exists after the first manual --source deploy).
# CI builds the image itself and pushes here (deploy-by-image) — `gcloud run
# deploy --source` was rejected for CI because it needs project-level
# storage.buckets.list; the deployer SA holds NO storage grants at all.
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
  --project=sdfc-udp-dev --location=us-west2 --member="$DEPLOYER" \
  --role=roles/artifactregistry.writer

# actAs on the runtime SA only (Cloud Run --source deploys need it)
gcloud iam service-accounts add-iam-policy-binding \
  marketing-portal-sa@sdfc-udp-dev.iam.gserviceaccount.com \
  --project=sdfc-udp-dev \
  --role=roles/iam.serviceAccountUser \
  --member="$DEPLOYER"
```

Because the staging bucket and AR repo are created by the first deploy, run the
first `api/deploy.sh` as yourself, then apply the two scoped bindings, then CI
takes over. The deployer deliberately has: no access to any data bucket
(`sdfc-dev-*`), no BigQuery role, no Secret Manager role.

Then in the GitHub repo settings → Actions → Variables, add
`FIREBASE_WEB_API_KEY` (the web app apiKey from step 1.3 — public identifier,
a variable not a secret is fine).

If the repo moves to an org later, update the `--attribute-condition` and the
`principalSet` member to the new `owner/name`.

## 4. First deploy (manual, before CI/CD exists)

```bash
cd api && ./deploy.sh
cd ../frontend && npm run build
firebase deploy --only hosting --project sdfc-udp-dev
```

## 5. First admin user (bootstrap)

Until the invite endpoint ships, create the first admin by hand from a machine
with ADC:

```python
# pip install firebase-admin
import firebase_admin
from firebase_admin import auth

firebase_admin.initialize_app(options={"projectId": "sdfc-udp-dev"})
user = auth.get_user_by_email("dean.klear@pmygroup.com")
# ⚠️ SHARED AUTH STORE: sdfc-udp-dev Firebase Auth also holds the scouting
# sandbox app's users, which use their own `role` claim. The portal claim is
# namespaced `portal_role`, and claim writes must MERGE (set_custom_user_claims
# replaces the entire dict — read existing claims first).
auth.set_custom_user_claims(user.uid, {**(user.custom_claims or {}), "portal_role": "admin"})
```

Sign in once, change the password, invite others from the portal (Phase 2).

## 6. Tripwires (Phase 4, executed 2026-07-26)

State tables `customerio_state.tripwires` / `tripwire_checks` (portal-sa
already dataset WRITER — **no new IAM for Phase 4**). Seeded tripwires:
`tripwire-newsletter` (quiet-days 14) / `tripwire-transport` /
`tripwire-welcome`@qa.sdfc.dev, provisioned through the Welcome-General test
webhook. Tripwire emails MUST be @qa.sdfc.dev — the sink rejects other
recipient domains at RCPT.

Check schedule: every 5 minutes (same OIDC contract as the harness tick;
daily → hourly → */5 on 2026-07-27 — detection latency matters more than the
~$2-3/mo compute):

```bash
gcloud scheduler jobs create http tripwire-daily-check \
  --project=sdfc-udp-dev --location=us-west2 \
  --schedule="*/5 * * * *" \
  --uri="https://marketing-portal-api-133738605371.us-west2.run.app/api/tripwires/tick" \
  --http-method=POST \
  --oidc-service-account-email=marketing-portal-sa@sdfc-udp-dev.iam.gserviceaccount.com \
  --oidc-token-audience=sdfc-marketing-portal-tick
```

## 7. Proactive alerting via Postmark (Phase 4b, executed 2026-07-26)

Postmark server **"sdfc.dev"** (ID 20070642); server token stored as secret
`postmark-marketing-token` (portal-sa: accessor granted). Alert sender
`api/app/emailer.py` — best-effort by contract, a failed send can never break
the tick that produced it. Hooks: tripwire check runs email on any FAIL;
harness runs that go FAILED/TIMED_OUT on the *scheduler* tick email (manual
advances don't — the operator is watching). Recipients are UI-managed (Admin → Alert recipients →
`customerio_state.alert_recipients`); empty table falls back to the ops owner
so alerts can never go nowhere. Alert policy (state in
`customerio_state.tripwire_alert_state`): immediate email on new/changed
failure set, reminder every 60 min while unresolved, recovery email on clear;
failed sends stay armed and retry on the next 5-minute run.

DNS on sdfc.dev (via `cloudflare-dns-sdfc-dev` token): `pm-bounces` CNAME →
pm.mtasv.net (Return-Path), apex TXT SPF `v=spf1 include:spf.mtasv.net ~all`,
`_dmarc` TXT `v=DMARC1; p=none;` (tighten after DKIM verifies).

**Pending — the one manual step:** add domain `sdfc.dev` in Postmark
(Sender Signatures → Domains; account-scope, server tokens can't) and create
its DKIM TXT record in Cloudflare. Until DKIM verifies, sends return
"not a Sender Signature" and alerts report `sent: false`.
