# SDFC Marketing Ops Portal

Internal portal at **https://marketing.sdfc.dev** for validating and testing
Customer.io campaigns against the QA mail sink (`qa.sdfc.dev` / Mailpit), viewing
customer activity, and monitoring tripwire accounts.

Design docs live in `sdfc-udp/repodocs/`: `MARKETING_PORTAL_PLAN.md` (this
product) and `CIO_TEST_HARNESS_UI_PLAN.md` (harness validator/runner spec).

## Layout

- `frontend/` — React 19 + TypeScript SPA. Vite 8, Tailwind v4, shadcn/ui on
  **Base UI** (`base-nova` preset), React Router v8 (data mode), TanStack Query,
  Firebase Auth (invite-only, role custom claims).
- `api/` — FastAPI on Cloud Run (`marketing-portal-api`, us-west2,
  project `sdfc-udp-dev`). Verifies Firebase ID tokens + `role` claim on every
  route. Houses the harness validator (Phase 1) and, in later phases, the
  test runner, customer lookup, and tripwire asserts.
- `firebase.json` — Firebase Hosting config: serves `frontend/dist`, rewrites
  `/api/**` to the Cloud Run service (same-origin in production, so no CORS in
  the browser), SPA fallback for everything else.

## Roles

| Role | Can |
|---|---|
| `viewer` | validate wiring, view dashboards/tripwires |
| `operator` | + run test-pair campaigns |
| `admin` | + prod-mode runs, invites |

Roles are Firebase custom claims stamped at invite time. A signed-in account
with no role claim gets 403 on every API route.

## Local development

Backend (needs gcloud ADC with access to `sdfc-udp-dev` secrets):

```bash
cd api
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DISABLE_AUTH=1 ENV=local .venv/bin/uvicorn app.main:app --port 8123
```

`DISABLE_AUTH=1` is honored only together with `ENV=local`.

Frontend (Vite proxies `/api` → `localhost:8123`):

```bash
cd frontend
cp .env.example .env   # fill VITE_FIREBASE_API_KEY (console → project settings)
npm install
npm run dev
```

Validator CLI (no server needed):

```bash
cd api && .venv/bin/python -m app.validator Welcome-General-260715
```

## Deploy

- API: `cd api && ./deploy.sh` (Cloud Run, `--allow-unauthenticated` is required
  for Hosting rewrites — auth is enforced in-app via Firebase tokens).
- Frontend: `cd frontend && npm run build && firebase deploy --only hosting --project sdfc-udp-dev`

One-time platform setup (console steps, custom domain, SA/IAM, invites): see
[SETUP.md](SETUP.md).

## Slug registry

`api/config/slugs.yaml` — one entry per campaign slug: trigger key, expected
event names, webhook secret names, and the Send Event payload contract. Keep in
sync with `cio_trigger_hub/triggers.py`. Unknown slugs still validate, but the
payload-contract check downgrades to a warning.
