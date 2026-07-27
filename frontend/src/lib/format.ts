// Human-readable presentation for harness data. Raw values (run ids,
// identities) stay available where tracking needs them.

export function humanizeSlug(slug: string): string {
  // "Welcome-General-260715" → "Welcome General" (trailing date code dropped)
  return slug.replace(/-\d{6}$/, '').replace(/-/g, ' ');
}

export function shortIdentity(identity: string): string {
  return identity.replace(/@qa\.sdfc\.dev$/, '');
}

export const statusLabel: Record<string, string> = {
  RUNNING: 'Running',
  PASSED: 'Passed',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
};

export const stageLabel: Record<string, string> = {
  created: 'Created',
  fired: 'Webhook fired',
  email1_engaged: 'Email 1 engaged',
  email2_engaged: 'Email 2 engaged',
  asserted: 'Verified',
  timeout: 'Timed out',
};

export function humanStage(stage: string): string {
  return stageLabel[stage] ?? stage;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatUtc(iso: string, withDate = true): string {
  const d = new Date(iso);
  const time = iso.includes('T') ? iso.slice(11, 16) : '';
  if (!withDate) return `${time} UTC`;
  const year = d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}${time ? ` · ${time} UTC` : ''}`;
}

export function formatUnix(ts: number | null | undefined): string {
  if (!ts) return '—';
  return formatUtc(new Date(ts * 1000).toISOString());
}

export function relativeFrom(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const ATTR_ACRONYMS = new Set(['stm', 'cio', 'tb', 'sf', 'sfmc', 'mls', 'tm', 'id', 'kbyg']);

export function humanizeAttr(name: string): string {
  return name
    .split('_')
    .map((w, i) =>
      ATTR_ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    )
    .join(' ');
}
