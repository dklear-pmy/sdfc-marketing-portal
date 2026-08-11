// Human-readable presentation for harness data. Raw values (run ids,
// identities) stay available where tracking needs them.

export function humanizeSlug(slug: string): string {
  // "Welcome-General-260715" → "Welcome General 260715" — the date stays: it
  // names the campaign generation (Dean, 2026-08-11).
  return slug.replace(/-/g, ' ');
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

const PACIFIC = 'America/Los_Angeles';

function ptParts(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/* All absolute times display in Pacific — the club's timezone — per Dean
   (2026-07-30). Data stays UTC end to end; only rendering converts. */
export function formatPacific(iso: string, withDate = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (!iso.includes('T')) {
    /* A calendar date, not an instant — render it literally; converting it
       through a timezone would shift it to the previous evening. */
    const year = d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
  }
  const p = ptParts(d);
  const time = `${p.hour}:${p.minute} ${(p.dayPeriod || '').toLowerCase()} PT`;
  if (!withDate) return time;
  const year = p.year !== ptParts(new Date()).year ? ` ${p.year}` : '';
  return `${p.month} ${p.day}${year} · ${time}`;
}

export function formatUnix(ts: number | null | undefined): string {
  if (!ts) return '—';
  return formatPacific(new Date(ts * 1000).toISOString());
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

/* Parse-and-reindent a stored JSON string for display; non-JSON passes through. */
export function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
