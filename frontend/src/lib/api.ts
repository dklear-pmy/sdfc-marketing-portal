import { auth } from './firebase';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      /* plain-text error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---- API types (hand-written for Phase 1; replaced by openapi-typescript once
// the backend surface stabilizes) ----

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface ValidationCheck {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface CampaignSummary {
  id: number;
  name: string;
  role: 'test_trigger' | 'test_journey' | 'prod_trigger' | 'prod_journey';
  state: string;
  event_name: string | null;
}

export interface ValidationReport {
  slug: string;
  generated_at: string;
  campaigns: CampaignSummary[];
  checks: ValidationCheck[];
  summary: { pass: number; fail: number; warn: number; skip: number };
}

export interface SlugEntry {
  slug: string;
  trigger_key: string | null;
  /* user-editable display name for the trigger; trigger_key stays the stable
     internal identity (hub state rows, env vars) */
  trigger_label: string | null;
  event_name: string | null;
  test_event_name: string | null;
  payload_fields: string[];
  person_attributes: string[];
  filter_fields: string[];
  webhook_secrets: string[];
  test_webhook_secret: string | null;
  test_webhook_url: string | null;
  /* the live [1/2] campaign's inbound webhook — composer sample payloads
     only; the runner never fires it */
  prod_webhook_url: string | null;
  payload_template: string | null;
  /* real-data shadow runs auto-fire on new live candidates when true */
  shadow_armed: boolean;
  notes: string | null;
  updated_at: string | null;
  updated_by: string | null;
  runnable?: boolean;
}

/* Result of POST /api/slugs/{slug}/sample — one contract-shaped payload
   fired at the test or prod inbound webhook to seed the composer's Trigger
   data sample. */
export interface SampleResult {
  target: 'test' | 'prod';
  status_code: number;
  ok: boolean;
  identity: string;
  /* the prod campaign's live state at send time (prod target only) */
  state: string | null;
  payload: Record<string, unknown>;
}

export interface SlugListResponse {
  slugs: SlugEntry[];
  /* The tb_signup shape the runner sends when a slug has no template of its
     own — offered as the editor's starting point. */
  default_payload_template: string;
  payload_tokens: Record<string, string>;
}

export type PrecheckLevel = 'fail' | 'warn' | 'info';

export interface PrecheckFinding {
  level: PrecheckLevel;
  message: string;
  /* A registry field/value the portal can apply in one click — only the
     registry side is ever offered; renames inside Customer.io stay manual. */
  fix?: { field: 'event_name' | 'test_event_name'; value: string; label: string };
}

export interface SlugPrecheck {
  slug: string;
  generated_at: string;
  registered: boolean;
  campaigns: CampaignSummary[];
  findings: PrecheckFinding[];
  secrets: Record<string, boolean | null>;
  suggested: {
    event_name?: string;
    test_event_name?: string;
    payload_fields?: string[];
    person_attributes?: string[];
  };
  runnable: boolean;
  runnable_reason: string | null;
  /* The exact payload a run would POST (sample identity scenario-000), and
     whether it comes from this slug's own template or the signup default. */
  payload_preview?: Record<string, unknown>;
  payload_is_custom?: boolean;
}

export interface SlugVariablesCioRow {
  role: 'test_trigger' | 'prod_trigger';
  campaign_id: number;
  campaign_name: string | null;
  /* null = no Send Event action found (itself a finding) */
  send_event_fields: string[] | null;
  person_attribute_fields: string[];
  recipient_field: string | null;
}

export interface SlugVariablesLiquidRow {
  pair: 'test' | 'prod';
  scope: 'trigger' | 'event' | 'customer';
  field: string;
  emails: string[];
  /* Where the reference appears, with ±10 words of surrounding email text. */
  contexts: { email: string; context: string }[];
}

export interface SlugVariables {
  slug: string;
  generated_at: string;
  template: { keys: string[]; is_custom: boolean };
  registry: {
    payload_fields: string[];
    person_attributes: string[];
    /* Declared journey entry-filter inputs — not readable via the App API. */
    filter_fields: string[];
  };
  cio: SlugVariablesCioRow[];
  liquid: SlugVariablesLiquidRow[];
}

export interface RunTimelineEntry {
  ts: string;
  stage: string;
  detail: string;
  /* Mailpit message ID, present on delivery/engagement entries — deep-links
     straight to the email in the sink UI. */
  msg_id?: string;
}

export interface HarnessRunSummary {
  run_id: string;
  slug: string;
  identity: string;
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'TIMED_OUT';
  stage: string;
  detail: string | null;
  started_at: string;
  updated_at: string;
  /* 'shadow' = fired on a sanitized REAL event row; absent/'synthetic' = template */
  mode?: string | null;
  source_key?: string | null;
}

export interface ShadowCandidate {
  dedup_key: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  event_at: string | null;
  already_run: boolean;
}

export type AttrStatus = 'match' | 'differs' | 'pending' | 'cio_only' | 'empty';

export interface AttrComparison {
  name: string;
  warehouse: unknown;
  cio: unknown;
  status: AttrStatus;
  cio_updated_at: string | null;
}

export interface CustomerLookup {
  email: string;
  generated_at: string;
  cio: {
    found: boolean;
    cio_id?: string;
    id?: string | null;
    unsubscribed?: boolean;
    segments?: { id: number | null; name: string }[];
    last_attribute_write?: string | null;
    attributes?: Record<string, unknown> | null;
  };
  warehouse: {
    found: boolean;
    updated_at: string | null;
    table_built_at: string | null;
    row: Record<string, unknown> | null;
  };
  sync: {
    in_sync_view: boolean;
    excluded_reason: string | null;
    /* Set when the fan is in the sync view but has no CIO profile yet —
       the estimated time of the next hourly Data-In pull. */
    first_sync_eta: string | null;
    /* Set when the warehouse row changed after the connector's last write of
       this profile and the pull carrying it hasn't run yet — mismatches are
       in-flight cargo (reported as 'pending'), not drift. */
    sync_due_eta: string | null;
    comparison: AttrComparison[];
    summary: Partial<Record<AttrStatus, number>>;
  };
}

export interface CioActivity {
  id: string;
  type: string;
  timestamp: number;
  name?: string | null;
  data?: Record<string, unknown> | null;
  delivery_type?: string | null;
}

export interface CioMessage {
  id: string;
  subject: string | null;
  type: string;
  created: number;
  campaign_id: number | null;
  newsletter_id: number | null;
  transactional_message_id: number | null;
  metrics: Record<string, number | null>;
  failure_message: string | null;
}

export interface ActivitiesPage {
  activities: CioActivity[];
  next: string | null;
}

export interface MessagesPage {
  messages: CioMessage[];
  next: string | null;
}

export interface FanRow {
  email: string;
  full_name: string | null;
  sprocket_macro: string | null;
  stm_product: string | null;
  stm_type: string | null;
  ticketing_member_status: string | null;
  matches_attended_2026: number | null;
  matches_attended_lifetime: number | null;
  last_attendance_date: string | null;
  lifetime_spend: number | null;
  /* The two components of lifetime_spend: SOLD seats from the reconciled
     seat ledger, and all-time Shopify merch. */
  ticket_lifetime_spend: number | null;
  shopify_amount_spent: number | null;
  tb_fan_source: string | null;
  updated_at: string;
}

export interface FanListPage {
  fans: FanRow[];
  total: number;
  limit: number;
  offset: number;
}

/* One cio-trigger-hub fire attempt for a campaign's trigger — the
   "affected customers" row. payload_json is the exact JSON the campaign's
   inbound webhook received. */
export interface AffectedCustomerRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: 'sent' | 'failed' | 'suppressed' | 'baseline' | string;
  status_code: number | null;
  error: string | null;
  fired_at: string;
  dedup_key: string;
  /* null on bootstrap rows (baseline/suppressed) — those never fired, so
     there was no webhook payload to record */
  payload_json: string | null;
}

export interface AffectedCustomersPage {
  /* null = slug registered but no trigger key mapped yet */
  trigger_key: string | null;
  /* the registry's editable display name for the trigger, if set */
  trigger_label: string | null;
  rows: AffectedCustomerRow[];
  total: number;
  limit: number;
  offset: number;
  statuses: string[];
}

/* One customer the trigger hub WOULD select on its next run — the live
   warehouse preview (vw_campaign_would_fire: candidate SQL minus everyone
   already in the fire log). payload_json is the JSON the webhook would
   receive. */
export interface WouldFireRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  /* the triggering moment (e.g. TB activity time); null for triggers whose
     logic has no event timestamp (attribute-state diffs like single-game) */
  event_at: string | null;
  dedup_key: string;
  payload_json: string | null;
}

export interface WouldFirePage {
  /* null = slug registered but no trigger key mapped yet */
  trigger_key: string | null;
  /* the registry's editable display name for the trigger, if set */
  trigger_label: string | null;
  rows: WouldFireRow[];
  total: number;
  limit: number;
  offset: number;
  /* the trigger's max_per_run circuit breaker; total > cap means the hub
     would skip-and-alert instead of sending. null for unknown triggers */
  cap: number | null;
  /* mirror of the trigger's enabled flag in the hub. false = the preview
     shows drafted/placeholder logic the hub won't execute yet; null for
     unknown triggers */
  enabled: boolean | null;
}

export interface LedgerStatus {
  email: string;
  status_domain: string;
  status: string;
  status_since: string | null;
  latched: boolean;
  authority: string | null;
  last_event_at: string | null;
  last_event_id: string | null;
  updated_at: string | null;
}

export interface LedgerEvent {
  event_id: string;
  ts: string;
  activity: string;
  source_system: string | null;
  is_system_echo: boolean;
  revenue_impact: number | null;
  feature_json: string | null;
}

export interface FanLedgerPage {
  email: string;
  statuses: LedgerStatus[];
  events: LedgerEvent[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface LedgerEventRow extends LedgerEvent {
  customer: string;
}

export interface LedgerEventsPage {
  events: LedgerEventRow[];
  total: number;
  limit: number;
  offset: number;
  activities: string[];
  sources: string[];
}

export interface LedgerStatusRow {
  email: string;
  status_domain: string;
  status: string;
  status_since: string | null;
  latched: boolean;
  authority: string | null;
  last_event_at: string | null;
  updated_at: string | null;
}

export interface LedgerStatusesPage {
  statuses: LedgerStatusRow[];
  total: number;
  limit: number;
  offset: number;
  domains: string[];
  status_values: string[];
}

export type TripwireStatus = 'PASS' | 'WARN' | 'FAIL';

export interface TripwireCheckRow {
  check_name: string;
  status: TripwireStatus;
  detail: string | null;
  checked_at: string;
}

export interface Tripwire {
  email: string;
  label: string;
  purpose: string | null;
  /* 'guard_sub' | 'guard_unsub' — the two fixed subscription-flag dummies —
     or 'campaign' (default) for accounts planted in a journey's audience. */
  kind: string | null;
  expect_subscribed: boolean;
  max_quiet_days: number | null;
  active: boolean;
  created_at: string | null;
  created_by: string | null;
  guard_pending: boolean | null;
  unsubscribed_at: string | null;
  deleted_at: string | null;
  provision_slug: string | null;
  overall: string;
  checks: TripwireCheckRow[];
}

export interface TripwiresState {
  tripwires: Tripwire[];
  /* Soft-deleted tripwires — hidden from checks, restorable. */
  deleted: Tripwire[];
  workspace: { overall: string; checks: TripwireCheckRow[] };
  /* Synthetic canary — generates its own traffic, so unlike the tripwires it
     can fail even when nothing else is happening. */
  canary: { overall: string; checks: TripwireCheckRow[]; email: string };
  last_run_at: string | null;
}

export interface TripwireHistoryRow {
  checked_at: string;
  email: string;
  check_name: string;
  status: TripwireStatus;
  detail: string | null;
  source: string | null;
}

export interface StadiumEventRow {
  event_name: string;
  event_date: string | null;
  sections: number;
  sold: number | null;
  occupied: number | null;
  scanned: number | null;
  total_seats: number | null;
  pct_sold: number | null;
  pct_occupied: number | null;
}

export interface StadiumEventsResponse {
  events: StadiumEventRow[];
  next_event: string | null;
  generated_at: string;
}

export interface StadiumSectionHeat {
  section: string;
  data_code: string;
  category: string;
  sold: number | null;
  occupied: number | null;
  scanned: number | null;
  total_seats: number | null;
  pct_sold: number | null;
  cx: number | null;
  cy: number | null;
}

export interface StadiumHeatResponse {
  event: string;
  sections: StadiumSectionHeat[];
  generated_at: string;
}

export interface HarnessRun {
  run_id: string;
  slug: string;
  identity: string;
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'TIMED_OUT';
  stage: string;
  engagement_path: string;
  started_by: string | null;
  started_at: string;
  updated_at: string;
  timeline: RunTimelineEntry[];
  detail: string | null;
}
