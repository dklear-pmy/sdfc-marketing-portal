#!/usr/bin/env bash
# Deploy the API to Cloud Run in sdfc-udp-dev. Project is hardcoded by policy.
set -euo pipefail

PROJECT=sdfc-udp-dev
REGION=us-west2
SERVICE=marketing-portal-api
SA=marketing-portal-sa@${PROJECT}.iam.gserviceaccount.com

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --source=. \
  --service-account="${SA}" \
  --set-env-vars="CORS_ORIGINS=https://marketing.sdfc.dev" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi
