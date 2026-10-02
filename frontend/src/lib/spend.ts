import type { DagState, FindingKind, FindingStatus } from '@/lib/api';
import type { badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export function usd(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function usdDelta(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${usd(Math.abs(v), digits)}`;
}

export function pct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const p = (ratio - 1) * 100;
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`;
}

export function gib(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
}

export const STATE_LABEL: Record<DagState, string> = {
  learning: 'Learning',
  armed: 'Armed',
  unreviewed_change: 'Unreviewed change',
  review: 'Review',
};

export const STATE_VARIANT: Record<DagState, BadgeVariant> = {
  learning: 'outline',
  armed: 'success',
  unreviewed_change: 'warning',
  review: 'destructive',
};

export const KIND_LABEL: Record<FindingKind, string> = {
  schedule_changed: 'Schedule changed',
  new_dag: 'New DAG',
  new_table: 'New table',
  scan_growth: 'Scan growth',
  stacking: 'Runs stacking',
  silence: 'Silent',
  hourly_total: 'Hourly total',
  ceiling: 'Ceiling',
  retries: 'Retried attempts',
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  accepted: 'Accepted',
  resolved: 'Resolved',
};

export const STATUS_VARIANT: Record<FindingStatus, BadgeVariant> = {
  open: 'destructive',
  acknowledged: 'warning',
  accepted: 'success',
  resolved: 'secondary',
};

/* Spend going up is bad: delta text colour follows direction × polarity. */
export function deltaClass(delta: number | null | undefined, upIsBad = true): string {
  if (delta == null || Math.abs(delta) < 0.005) return 'text-muted-foreground';
  const bad = upIsBad ? delta > 0 : delta < 0;
  return bad ? 'text-destructive' : 'text-sdfc-green-dark dark:text-sdfc-green';
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}
