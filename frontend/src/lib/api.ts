import { auth } from "./firebase"

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ""

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const user = auth.currentUser
  const token = user ? await user.getIdToken() : null
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try {
      detail = JSON.parse(body).detail ?? body
    } catch {
      /* plain-text error body */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
}

// ---- API types (hand-written for Phase 1; replaced by openapi-typescript once
// the backend surface stabilizes) ----

export type CheckStatus = "pass" | "fail" | "warn" | "skip"

export interface ValidationCheck {
  id: string
  name: string
  status: CheckStatus
  detail: string
}

export interface CampaignSummary {
  id: number
  name: string
  role: "test_trigger" | "test_journey" | "prod_trigger" | "prod_journey"
  state: string
  event_name: string | null
}

export interface ValidationReport {
  slug: string
  generated_at: string
  campaigns: CampaignSummary[]
  checks: ValidationCheck[]
  summary: { pass: number; fail: number; warn: number; skip: number }
}

export interface RunTimelineEntry {
  ts: string
  stage: string
  detail: string
}

export interface HarnessRunSummary {
  run_id: string
  slug: string
  identity: string
  status: "RUNNING" | "PASSED" | "FAILED" | "TIMED_OUT"
  stage: string
  detail: string | null
  started_at: string
  updated_at: string
}

export type AttrStatus = "match" | "differs" | "pending" | "cio_only" | "empty"

export interface AttrComparison {
  name: string
  warehouse: unknown
  cio: unknown
  status: AttrStatus
  cio_updated_at: string | null
}

export interface CustomerLookup {
  email: string
  generated_at: string
  cio: {
    found: boolean
    cio_id?: string
    id?: string | null
    unsubscribed?: boolean
    segments?: string[]
    last_attribute_write?: string | null
    attributes?: Record<string, unknown> | null
  }
  warehouse: {
    found: boolean
    updated_at: string | null
    table_built_at: string | null
    row: Record<string, unknown> | null
  }
  sync: {
    in_sync_view: boolean
    excluded_reason: string | null
    comparison: AttrComparison[]
    summary: Partial<Record<AttrStatus, number>>
  }
}

export interface CioActivity {
  id: string
  type: string
  timestamp: number
  name?: string | null
  data?: Record<string, unknown> | null
  delivery_type?: string | null
}

export interface CioMessage {
  id: string
  subject: string | null
  type: string
  created: number
  campaign_id: number | null
  newsletter_id: number | null
  transactional_message_id: number | null
  metrics: Record<string, number | null>
  failure_message: string | null
}

export interface ActivitiesPage {
  activities: CioActivity[]
  next: string | null
}

export interface MessagesPage {
  messages: CioMessage[]
  next: string | null
}

export interface HarnessRun {
  run_id: string
  slug: string
  identity: string
  status: "RUNNING" | "PASSED" | "FAILED" | "TIMED_OUT"
  stage: string
  engagement_path: string
  started_by: string | null
  started_at: string
  updated_at: string
  timeline: RunTimelineEntry[]
  detail: string | null
}
