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
