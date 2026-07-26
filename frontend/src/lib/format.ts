// Human-readable presentation for harness data. Raw values (run ids,
// identities) stay available where tracking needs them.

export function humanizeSlug(slug: string): string {
  // "Welcome-General-260715" → "Welcome General" (trailing date code dropped)
  return slug.replace(/-\d{6}$/, "").replace(/-/g, " ")
}

export function shortIdentity(identity: string): string {
  return identity.replace(/@qa\.sdfc\.dev$/, "")
}

export const statusLabel: Record<string, string> = {
  RUNNING: "Running",
  PASSED: "Passed",
  FAILED: "Failed",
  TIMED_OUT: "Timed out",
}

export const stageLabel: Record<string, string> = {
  created: "Created",
  fired: "Webhook fired",
  email1_engaged: "Email 1 engaged",
  email2_engaged: "Email 2 engaged",
  asserted: "Verified",
  timeout: "Timed out",
}

export function humanStage(stage: string): string {
  return stageLabel[stage] ?? stage
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function formatUtc(iso: string, withDate = true): string {
  const d = new Date(iso)
  const time = iso.includes("T") ? iso.slice(11, 16) : ""
  if (!withDate) return `${time} UTC`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${time} UTC`
}
