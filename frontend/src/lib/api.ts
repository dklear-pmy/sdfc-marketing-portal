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

export interface RunTimelineEntry {
  ts: string;
  stage: string;
  detail: string;
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
    segments?: string[];
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
  tb_fan_source: string | null;
  updated_at: string;
}

export interface FanListPage {
  fans: FanRow[];
  total: number;
  limit: number;
  offset: number;
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
  expect_subscribed: boolean;
  max_quiet_days: number | null;
  active: boolean;
  created_at: string | null;
  created_by: string | null;
  overall: string;
  checks: TripwireCheckRow[];
}

export interface TripwiresState {
  tripwires: Tripwire[];
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
