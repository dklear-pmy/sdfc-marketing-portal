/* Trigger Manager (its own nav area): the warehouse triggers that actually
   send the webhooks. Each row is a cio-trigger-hub trigger — a BigQuery
   selection that finds matching customers and POSTs one webhook per person
   into its campaign's [1/2] relay. Joined against the slug registry so a
   key mismatch is visible from either side: a registry key the hub doesn't
   carry ("Not in hub" — fires nothing, ever) or a hub trigger no campaign
   is registered to (fires into a webhook nobody validates). Trigger SQL
   and caps live in the hub's triggers.py; each trigger's STATE (Enabled /
   Disabled / Draft) is set here and read by the hub every run.

   Mirrors the campaigns area's shape: a searchable list (Enabled/Disabled
   filter, default enabled; "Not in hub" errors surface under BOTH filters
   so a misconfiguration can never hide), and a per-trigger drilldown with
   tabs — Overview (facts, selection logic, payload contract) and Matching
   Customers (live next-run selection + trailing-90-day history). */

import { Fragment, useState } from 'react';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type TriggerKillInfo,
  type TriggerLastRun,
  type TriggerRow,
  type WouldFirePage,
} from '@/lib/api';
import { Loader2Icon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useUrlFilters } from '@/lib/urlState';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import SampleSender from '@/components/SampleSender';
import { ExportExcelButton } from '@/components/ExportExcel';
import { PreviewCountSkeleton, PreviewTableSkeleton } from '@/components/PreviewSkeleton';
import { formatPacific, prettyPayload, relativeFrom } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { HoverTip } from '@/components/ui/hover-tip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const AFFECTED_PAGE = 20;
const HISTORY_DAYS = 90;
/* Preview fetch bound. The API's own result timeout is 25s; abort a hair
   under it so a stalled request fails here first and react-query retries
   (default 3x) instead of the skeleton sitting open-ended. */
const PREVIEW_TIMEOUT_MS = 20_000;

/* Is this trigger set to SEND on the next run? Every gate open: in the hub,
   code gate open, not emergency-stopped, Enabled toggle on. The hub-wide
   DRY_RUN override is separate — see HubDryRunBanner. */
function isLive(t: TriggerRow) {
  return t.in_hub && t.code_enabled === true && !t.killed && t.enabled;
}

function humanSkip(reason: string | null) {
  return reason ? ` (${reason.toLowerCase().replace(/_/g, ' ')})` : '';
}

/* One line on what the hub's LAST run actually did with this trigger — the
   per-trigger indicator. "would send" = evaluated and counted, nothing sent. */
function lastRunLine(r: TriggerLastRun | null) {
  if (!r) return null;
  const when = relativeFrom(r.at);
  switch (r.mode) {
    case 'live':
      return `Last run ${when}: sent ${r.fired.toLocaleString()}${r.failed ? `, ${r.failed} failed` : ''}`;
    case 'dry_run':
      return r.skipped
        ? `Last run ${when}: skipped${humanSkip(r.skipped)}`
        : `Last run ${when}: ${r.candidates.toLocaleString()} would send — nothing sent`;
    case 'skipped':
      return `Last run ${when}: skipped${humanSkip(r.skipped)}`;
    default:
      return `Last run ${when}: error`;
  }
}

type TriggerState = TriggerRow['state'];
const STATE_ORDER: TriggerState[] = ['draft', 'disabled', 'enabled'];
const STATE_LABEL: Record<TriggerState, string> = {
  draft: 'Draft',
  disabled: 'Disabled',
  enabled: 'Enabled',
};

/* Three-way state picker. Draft = still being built · Disabled = built and
   reviewed, off · Enabled = sending. Draft and Disabled both run dry in the
   hub — the split is a readiness label for people, not a hub behaviour. */
function StateSegments({
  value,
  canEdit,
  isAdmin,
  busy,
  pending,
  onPick,
}: {
  value: TriggerState;
  canEdit: boolean;
  isAdmin: boolean;
  busy?: boolean;
  /* the state currently being written, if any — it already reads as the
     selected segment (optimistically), so the spinner is what separates
     "asked for" from "the warehouse agrees" */
  pending?: TriggerState | null;
  onPick: (state: TriggerState) => void;
}) {
  return (
    <span
      role="radiogroup"
      aria-label="Trigger state"
      aria-busy={pending ? true : undefined}
      className="inline-flex rounded-md border bg-muted p-0.5"
    >
      {STATE_ORDER.map((st) => {
        const active = st === value;
        const locked = !canEdit || !!busy || (st === 'enabled' && !isAdmin);
        return (
          <button
            key={st}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={locked && !active}
            onClick={() => {
              if (!active && !locked) onPick(st);
            }}
            className={cn(
              'rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? st === 'enabled'
                  ? 'bg-sdfc-orange text-white'
                  : 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              locked && !active && 'cursor-not-allowed opacity-50'
            )}
          >
            <span className="inline-flex items-center gap-1">
              {pending === st && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
              {STATE_LABEL[st]}
            </span>
          </button>
        );
      })}
    </span>
  );
}

/* The Status cell. States nobody can change here get a badge; a code-open
   trigger gets the three-way picker. Enabling goes through the caller's
   confirmation (it starts real sends); Disabled and Draft apply
   immediately — they are the safe directions. */
function StatusControl({
  t,
  canEdit,
  isAdmin,
  busy,
  pending,
  refreshing,
  onEnable,
  onChange,
}: {
  t: TriggerRow;
  canEdit: boolean;
  isAdmin: boolean;
  busy?: boolean;
  pending?: TriggerState | null;
  /* the write landed and the overview is re-reading the counts behind it —
     a second, slower phase worth naming so the row doesn't look frozen */
  refreshing?: boolean;
  onEnable: () => void;
  onChange: (state: TriggerState) => void;
}) {
  const line = lastRunLine(t.last_run);
  let control: React.ReactNode;
  if (!t.in_hub) control = <Badge variant="destructive">Not in hub</Badge>;
  else if (t.killed) control = <Badge variant="destructive">Emergency off</Badge>;
  else if (t.code_enabled !== true)
    control = (
      <HoverTip content="Locked in draft: switched off in the hub's code — its query is a placeholder the hub never evaluates.">
        <Badge variant="secondary">Draft</Badge>
      </HoverTip>
    );
  else {
    const seg = (
      <StateSegments
        value={t.state}
        canEdit={canEdit}
        isAdmin={isAdmin}
        busy={busy}
        pending={pending}
        onPick={(st) => (st === 'enabled' ? onEnable() : onChange(st))}
      />
    );
    control =
      canEdit && !isAdmin ? (
        <HoverTip content="Enabling starts real sends — admin only.">{seg}</HoverTip>
      ) : (
        seg
      );
  }
  /* While anything is in flight the last-run line is stale by definition,
     so the progress line takes its place rather than sitting beside it. */
  const busyLine = pending
    ? `Saving ${STATE_LABEL[pending].toLowerCase()}\u2026`
    : refreshing
      ? 'Refreshing counts\u2026'
      : null;
  return (
    <span className="grid gap-1">
      {control}
      {busyLine ? (
        <span
          aria-live="polite"
          className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground"
        >
          <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          {busyLine}
        </span>
      ) : line ? (
        <span className="text-xs whitespace-nowrap text-muted-foreground">{line}</span>
      ) : null}
    </span>
  );
}

/* The hub-wide DRY_RUN override, as of the last run. While it's on, no
   trigger sends whatever its toggle says — toggles record intent, and each
   row's last-run line shows what WOULD have gone out. */
function HubDryRunBanner({ data }: { data: TriggersResponse | undefined }) {
  if (!data || data.hub_dry_run !== true) return null;
  return (
    <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-500 [&>div]:text-amber-700/90 dark:[&>div]:text-amber-500/90">
      <AlertTitle>Hub-wide dry run is on — nothing sends yet</AlertTitle>
      <AlertDescription>
        Every trigger is evaluated and counted but no webhook fires, whatever its Enabled toggle
        says. The toggles take effect the moment the hub&apos;s DRY_RUN override is lifted (Cloud
        Run job env). Last hub run{' '}
        {data.hub_last_run_at ? relativeFrom(data.hub_last_run_at) : 'not recorded yet'}.
      </AlertDescription>
    </Alert>
  );
}

/* Body of the enable confirmation — the numbers someone needs at the moment
   they can still say no, and the one decision that matters: absorb the
   current backlog as baseline first, or send to it. */
function EnableDescription({
  t,
  hubDryRun,
  reason,
  onReason,
  absorb,
  onAbsorb,
}: {
  t: TriggerRow;
  hubDryRun: boolean | null;
  reason: string;
  onReason: (v: string) => void;
  absorb: boolean;
  onAbsorb: (v: boolean) => void;
}) {
  const n = t.candidates;
  const over = t.cap != null && n > t.cap;
  const target = t.campaigns[0]?.display_name || t.campaigns[0]?.slug || 'its campaign';
  const people = `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;
  return (
    <span className="grid gap-3">
      <span>
        From the next hourly run the hub POSTs one webhook per matching customer into {target} —
        real fans, real emails. Right now <strong>{people}</strong> match
        {t.cap != null && <> (per-run cap {t.cap.toLocaleString()})</>}.
      </span>
      {n > 0 && (
        <span className="grid gap-2 rounded-md border p-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="enable-mode"
              className="mt-1 accent-sdfc-orange"
              checked={absorb}
              onChange={() => onAbsorb(true)}
            />
            <span>
              <strong>Absorb the {people} as already handled, then enable.</strong> They never get
              this email — only people who match from now on do. Right for a backlog that built up
              while the trigger was off.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="enable-mode"
              className="mt-1 accent-sdfc-orange"
              checked={!absorb}
              onChange={() => onAbsorb(false)}
            />
            <span>
              <strong>Enable and send to all {people} on the next run.</strong> Right only if every
              one of them should receive it now.
              {over && (
                <span className="block text-destructive">
                  That is above the per-run cap — the hub would skip and alert instead of sending.
                </span>
              )}
            </span>
          </label>
          <span className="text-xs text-muted-foreground">
            Absorbing writes them to the fire log as “baseline”. The count is re-evaluated at the
            moment you confirm, so anyone who matched in the meantime is absorbed too.
          </span>
        </span>
      )}
      <span className="text-muted-foreground">
        Switching it off later stops sends from the following run.
      </span>
      {hubDryRun === true && (
        <span className="text-muted-foreground">
          The hub-wide dry run is still on, so nothing sends until that override is lifted — this
          records the intent{absorb && n > 0 ? ' and absorbs the backlog now' : ''}.
          {absorb && n > 0 && t.key === 'tb_signup_260715'
            ? ' Note tb_signup’s window keeps rolling: absorb it in the same hour the override lifts, or a new backlog forms.'
            : ''}
        </span>
      )}
      <Input
        placeholder="Reason (optional, shown in the audit trail)"
        maxLength={300}
        value={reason}
        onChange={(e) => onReason(e.target.value)}
      />
    </span>
  );
}

interface TriggersResponse {
  triggers: TriggerRow[];
  hub_killed: TriggerKillInfo | null;
  /* the hub-wide DRY_RUN override as of the last run — while true nothing
     sends whatever the toggles say; null = no run recorded yet */
  hub_dry_run: boolean | null;
  hub_last_run_at: string | null;
  hub_target: string | null;
}

/* Shared kill-switch mutation — POST /api/triggers/{key}/kill. Killing is
   off-only on the hub side, so it can never send; lifting re-allows sends
   and the API restricts it to admins. */
function useKillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, killed, reason }: { key: string; killed: boolean; reason?: string }) =>
      api.post(`/api/triggers/${encodeURIComponent(key)}/kill`, { killed, reason }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['triggers'] }),
  });
}

/* Trigger state — POST /api/triggers/{key}/state. Disabled and Draft are
   operator-level; Enabled starts real sends and the API restricts it to
   admins. */
function useEnabledMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      state,
      reason,
      absorb,
    }: {
      key: string;
      state: TriggerState;
      reason?: string;
      absorb?: boolean;
    }) =>
      api.post<{ trigger_key: string; state: TriggerState; absorbed: number | null }>(
        `/api/triggers/${encodeURIComponent(key)}/state`,
        { state, reason, absorb }
      ),
    /* Flip the cell the moment the POST goes out. The write itself is quick
       (one MERGE on trigger_settings); what takes 10-20s is the refetch
       behind it, because /api/triggers re-runs every trigger's candidate
       count against the warehouse. Waiting for that made the click look
       ignored, so the state answers now and the counts catch up after. */
    onMutate: async ({ key, state }) => {
      await queryClient.cancelQueries({ queryKey: ['triggers'] });
      const previous = queryClient.getQueryData<TriggersResponse>(['triggers']);
      queryClient.setQueryData<TriggersResponse>(['triggers'], (old) =>
        old
          ? {
              ...old,
              triggers: old.triggers.map((t) =>
                t.key === key ? { ...t, state, enabled: state === 'enabled' } : t
              ),
            }
          : old
      );
      return { previous };
    },
    /* The API refuses some changes (enabling as a non-admin, a code-closed
       trigger, an unknown state) — put the real answer back rather than
       leave an optimistic lie on screen next to the error alert. */
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['triggers'], context.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['triggers'] }),
  });
}

/* Which row is mid-change, and in which of the two phases. Split out because
   the list and the drilldown both render StatusControl and must agree. */
function useStateBusy(m: ReturnType<typeof useEnabledMutation>) {
  const refetching = useIsFetching({ queryKey: ['triggers'] }) > 0;
  const key = m.variables?.key ?? null;
  return {
    savingKey: m.isPending ? key : null,
    savingState: m.isPending ? (m.variables?.state ?? null) : null,
    refreshingKey: !m.isPending && m.isSuccess && refetching ? key : null,
  };
}

function killDetail(info: TriggerKillInfo | null) {
  if (!info) return null;
  const parts = [];
  if (info.reason) parts.push(`“${info.reason}”`);
  if (info.by) parts.push(`by ${info.by}`);
  if (info.at) parts.push(relativeFrom(info.at));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function BulletBlock({ title, lines, empty }: { title: string; lines: string[]; empty: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h4>
      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed whitespace-normal">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Fire-log counts as labeled lines: FIRED = sent and accepted; ABSORBED =
   written without a send (baselines, suppressions); FAILED only when
   present (retried next hourly run). */
function FireLogCell({ t }: { t: TriggerRow }) {
  return (
    <span className="grid grid-cols-[auto_auto] justify-end gap-x-1.5 gap-y-0.5">
      <span className="text-right font-sans text-xs leading-5 font-medium text-muted-foreground">
        FIRED:
      </span>
      <span className="text-right">{t.fires_sent.toLocaleString()}</span>
      <span className="text-right font-sans text-xs leading-5 font-medium text-muted-foreground">
        ABSORBED:
      </span>
      <span className="text-right">{t.fires_absorbed.toLocaleString()}</span>
      {t.fires_failed > 0 && (
        <>
          <span className="text-right font-sans text-xs leading-5 font-medium text-muted-foreground">
            FAILED:
          </span>
          <span className="text-right text-destructive">{t.fires_failed.toLocaleString()}</span>
        </>
      )}
    </span>
  );
}

/* Loading shapes for the triggers list and drilldown — structured rows that
   mirror the real tables, so loading reads as "the table is coming" rather
   than an empty card (one featureless block on a dark card was effectively
   invisible). */
function TriggerListSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading triggers…</span>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-52">Status</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="text-right">Cap</TableHead>
              <TableHead className="text-right">Candidates</TableHead>
              <TableHead className="text-right">Fire log</TableHead>
              <TableHead>Last fired</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 6 }, (_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-5 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="mt-1 h-3 w-64" />
                </TableCell>
                <TableCell>
                  <Skeleton className="ml-auto h-4 w-8" />
                </TableCell>
                <TableCell>
                  <Skeleton className="ml-auto h-4 w-8" />
                </TableCell>
                <TableCell>
                  <Skeleton className="ml-auto h-4 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TriggerDrilldownSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading trigger…</span>
      <Skeleton className="h-9 w-36" />
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-64" />
          <Skeleton className="mt-1 h-4 w-80" />
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-56" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/* Who the trigger would affect: the live next-run selection, or every event
   of the trailing 90 days from the history table function. Same data the
   campaign drilldown's Matching Customers tab shows, addressed by trigger
   key so it works even for a trigger with no registered campaign. Strictly
   preview — the portal never fires a production webhook. */
function TriggerAffected({ t }: { t: TriggerRow }) {
  /* The window lives in the URL (twin=history; absent = next run) so both
     tabs are directly linkable, same as the drilldown's ttab. Paging stays
     local — a deep link always lands on page one. */
  const [{ twin }, setUrl] = useUrlFilters({ twin: '' }, ['twin']);
  const win: 'next' | 'history' = twin === 'history' ? 'history' : 'next';
  const [offset, setOffset] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['trigger-preview', t.key, win, offset],
    queryFn: () =>
      api.get<WouldFirePage>(
        `/api/triggers/${encodeURIComponent(t.key)}/preview?limit=${AFFECTED_PAGE}&offset=${offset}` +
          (win === 'history' ? `&days=${HISTORY_DAYS}` : ''),
        { timeoutMs: PREVIEW_TIMEOUT_MS }
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  const page = list.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const overCap = win === 'next' && page?.cap != null && total > page.cap;
  /* isPlaceholderData = what's on screen belongs to the PREVIOUS window or
     page, not the one now being fetched — so a window switch shows the
     skeleton instead of the old window's rows and count. isPending covers the
     first load, when there is nothing to hold over at all. */
  const loading = list.isPending || list.isPlaceholderData;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matching Customers</CardTitle>
        <CardDescription>
          {win === 'next'
            ? "Everyone this trigger's selection matches right now — who the next armed run would send to."
            : `Every event this trigger would have fired on in the last ${HISTORY_DAYS} days, had it been on.`}{' '}
          <strong className="font-medium text-foreground">
            These are real fans with real addresses
          </strong>{' '}
          — this list is preview-only and the portal never fires a production webhook.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Whole-campaign export: BOTH windows in one file, as worksheet
            tabs — distinct from the per-window button below the tabs. */}
        <div className="flex justify-start">
          <ExportExcelButton
            label="Export Campaign Excel"
            path={`/api/triggers/${encodeURIComponent(t.key)}/preview/export?windows=all&days=${HISTORY_DAYS}`}
          />
        </div>
        <Tabs
          value={win}
          onValueChange={(v) => {
            setUrl({ twin: v === 'history' ? 'history' : '' });
            setOffset(0);
          }}
        >
          <TabsList>
            <TabsTrigger value="next">Next Run</TabsTrigger>
            <TabsTrigger value="history">Last {HISTORY_DAYS} Days</TabsTrigger>
          </TabsList>
        </Tabs>
        {list.isError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the preview</AlertTitle>
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {loading && (
          <>
            <PreviewCountSkeleton />
            <PreviewTableSkeleton />
          </>
        )}
        {!loading && win === 'history' && page?.history_available === false && (
          <Alert>
            <AlertTitle>
              {page.no_history_reason
                ? 'History can’t be reconstructed for this trigger'
                : 'No history view for this trigger yet'}
            </AlertTitle>
            <AlertDescription>
              {page.no_history_reason ??
                'The history table function doesn’t carry this trigger’s branch — only the live next-run view is available.'}
            </AlertDescription>
          </Alert>
        )}
        {!loading && overCap && (
          <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-500 [&>div]:text-amber-700/90 dark:[&>div]:text-amber-500/90">
            <AlertTitle>
              {total.toLocaleString()} exceeds the per-run safety cap ({page!.cap!.toLocaleString()}
              )
            </AlertTitle>
            <AlertDescription>
              The hub would skip this run and alert instead of sending — a backlog this size needs
              its state re-baselined (backlog absorbed) before arming.
            </AlertDescription>
          </Alert>
        )}
        {!loading && page && !(win === 'history' && page.history_available === false) && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{total.toLocaleString()}</span>{' '}
                {win === 'next'
                  ? `${total === 1 ? 'customer' : 'customers'} currently selected.`
                  : `matching ${total === 1 ? 'event' : 'events'} in the last ${HISTORY_DAYS} days.`}
              </p>
              <ExportExcelButton
                path={
                  `/api/triggers/${encodeURIComponent(t.key)}/preview/export` +
                  (win === 'history' ? `?days=${HISTORY_DAYS}` : '')
                }
                disabled={total === 0}
              />
            </div>
            <div
              className={cn('overflow-x-auto rounded-md border', list.isFetching && 'opacity-60')}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="w-24">Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="h-16 text-center text-muted-foreground">
                        {win === 'next'
                          ? 'No customers currently match this trigger’s logic.'
                          : `No matching events in the last ${HISTORY_DAYS} days.`}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => {
                    const key = `${r.dedup_key}`;
                    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
                    return (
                      <Fragment key={key}>
                        <TableRow>
                          <TableCell className="text-sm whitespace-nowrap">
                            {r.event_at ? (
                              <>
                                <div>{formatPacific(r.event_at)}</div>
                                <div className="text-xs text-muted-foreground">
                                  {relativeFrom(r.event_at)}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {name && <div className="text-sm">{name}</div>}
                            <div className="text-xs text-muted-foreground">{r.email ?? '—'}</div>
                          </TableCell>
                          <TableCell>
                            {r.payload_json ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setOpenRow(openRow === key ? null : key)}
                              >
                                {openRow === key ? 'Hide' : 'View'}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {openRow === key && r.payload_json && (
                          <TableRow>
                            <TableCell colSpan={3} className="bg-muted/40">
                              <pre className="p-1 text-xs break-all whitespace-pre-wrap">
                                {prettyPayload(r.payload_json)}
                              </pre>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {total > AFFECTED_PAGE && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {rows.length === 0 ? '0' : `${offset + 1}–${offset + rows.length}`} of{' '}
                  {total.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - AFFECTED_PAGE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + AFFECTED_PAGE >= total}
                    onClick={() => setOffset(offset + AFFECTED_PAGE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const TRIGGER_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'preview', label: 'Matching Customers' },
] as const;
type TriggerTab = (typeof TRIGGER_TABS)[number]['key'];

function TriggerDrilldown({
  t,
  tab,
  onTab,
  onBack,
  onCampaign,
  hubDryRun,
}: {
  t: TriggerRow;
  tab: TriggerTab;
  onTab: (tab: TriggerTab) => void;
  onBack: () => void;
  onCampaign: (slug: string) => void;
  hubDryRun: boolean | null;
}) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const isAdmin = role === 'admin';
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(t.label ?? '');
  const rename = useMutation({
    mutationFn: (label: string) =>
      api.post(`/api/triggers/${encodeURIComponent(t.key)}/label`, { label }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['triggers'] });
    },
  });

  const kill = useKillMutation();
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmLift, setConfirmLift] = useState(false);
  const [killReason, setKillReason] = useState('');
  const setEnabled = useEnabledMutation();
  const stateBusy = useStateBusy(setEnabled);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [enableReason, setEnableReason] = useState('');
  const [enableAbsorb, setEnableAbsorb] = useState(true);

  return (
    <div className="grid gap-6">
      <div>
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back to triggers
        </Button>
      </div>

      <ConfirmDialog
        open={confirmKill}
        onOpenChange={setConfirmKill}
        destructive
        title={`Emergency-disable ${t.label ?? t.key}?`}
        confirmLabel="Emergency disable"
        description={
          <span className="grid gap-3">
            <span>
              The hub will skip this trigger on every run until the switch is deliberately lifted.
              This only stops sends — it cannot send anything.
            </span>
            <Input
              placeholder="Reason (optional, shown in the audit trail)"
              maxLength={300}
              value={killReason}
              onChange={(e) => setKillReason(e.target.value)}
            />
          </span>
        }
        onConfirm={() => kill.mutate({ key: t.key, killed: true, reason: killReason.trim() })}
      />
      <ConfirmDialog
        open={confirmLift}
        onOpenChange={setConfirmLift}
        destructive
        title={`Lift the emergency disable on ${t.label ?? t.key}?`}
        confirmLabel="Lift emergency disable"
        description={
          `Lifting re-allows sends for this trigger. Its selection currently matches ` +
          `${t.candidates.toLocaleString()} customer${t.candidates === 1 ? '' : 's'} — that is ` +
          `who the next armed run would send to.`
        }
        onConfirm={() => kill.mutate({ key: t.key, killed: false })}
      />
      <ConfirmDialog
        open={confirmEnable}
        onOpenChange={setConfirmEnable}
        title={`Enable ${t.label ?? t.key} — start sending?`}
        confirmLabel={
          enableAbsorb && t.candidates > 0
            ? `Absorb ${t.candidates.toLocaleString()} and enable`
            : 'Enable sends'
        }
        description={
          <EnableDescription
            t={t}
            hubDryRun={hubDryRun}
            reason={enableReason}
            onReason={setEnableReason}
            absorb={enableAbsorb}
            onAbsorb={setEnableAbsorb}
          />
        }
        onConfirm={() =>
          setEnabled.mutate({
            key: t.key,
            state: 'enabled',
            reason: enableReason.trim(),
            absorb: enableAbsorb && t.candidates > 0,
          })
        }
      />
      <HubDryRunBanner
        data={{
          triggers: [],
          hub_killed: null,
          hub_dry_run: hubDryRun,
          hub_last_run_at: t.last_run?.at ?? null,
          hub_target: null,
        }}
      />
      {setEnabled.isSuccess && setEnabled.data.state === 'enabled' && (
        <Alert>
          <AlertTitle>
            Enabled
            {setEnabled.data.absorbed != null
              ? ` — ${setEnabled.data.absorbed.toLocaleString()} absorbed as baseline`
              : ''}
          </AlertTitle>
          <AlertDescription>
            Sends start on the hub&apos;s next hourly run
            {hubDryRun ? ' (once the hub-wide dry run is lifted)' : ''}.
          </AlertDescription>
        </Alert>
      )}
      {setEnabled.isError && (
        <Alert variant="destructive">
          <AlertTitle>Enabled toggle update failed</AlertTitle>
          <AlertDescription>{(setEnabled.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {t.killed && (
        <Alert variant="destructive">
          <AlertTitle>Emergency-disabled — the hub skips this trigger on every run</AlertTitle>
          <AlertDescription>
            <span className="grid gap-2">
              <span>{killDetail(t.kill) ?? 'No reason recorded.'}</span>
              {isAdmin && (
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={kill.isPending}
                    onClick={() => setConfirmLift(true)}
                  >
                    Lift emergency disable
                  </Button>
                </span>
              )}
              {!isAdmin && <span>Lifting an emergency disable is admin-only.</span>}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {kill.isError && (
        <Alert variant="destructive">
          <AlertTitle>Kill-switch update failed</AlertTitle>
          <AlertDescription>{(kill.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate(nameInput.trim());
              }}
            >
              <Input
                className="w-80"
                autoFocus
                maxLength={80}
                placeholder={t.key}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={rename.isPending}>
                {rename.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setNameInput(t.label ?? '');
                }}
              >
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                Display name only — the trigger key stays the stable id. Blank falls back to the
                key.
              </span>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="text-xl">{t.label ?? t.key}</CardTitle>
              <StatusControl
                t={t}
                canEdit={canEdit}
                isAdmin={isAdmin}
                busy={setEnabled.isPending}
                pending={stateBusy.savingKey === t.key ? stateBusy.savingState : null}
                refreshing={stateBusy.refreshingKey === t.key}
                onEnable={() => {
                  setEnableReason('');
                  setEnableAbsorb(true);
                  setConfirmEnable(true);
                }}
                onChange={(state) => setEnabled.mutate({ key: t.key, state })}
              />
              {canEdit && t.campaigns.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => {
                    setNameInput(t.label ?? '');
                    setEditing(true);
                  }}
                >
                  Rename
                </Button>
              )}
              {canEdit && !t.killed && t.in_hub && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="ml-auto"
                  disabled={kill.isPending}
                  onClick={() => {
                    setKillReason('');
                    setConfirmKill(true);
                  }}
                >
                  Emergency disable
                </Button>
              )}
            </div>
          )}
          {rename.isError && (
            <p className="text-xs text-destructive">{(rename.error as Error).message}</p>
          )}
          {t.label && <code className="text-xs text-muted-foreground">{t.key}</code>}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="w-44 font-medium">Feeds campaign</TableCell>
                  <TableCell>
                    {t.campaigns.length === 0 ? (
                      <span className="text-muted-foreground">
                        — no campaign registered to this key
                      </span>
                    ) : (
                      t.campaigns.map((c) => (
                        <button
                          key={c.slug}
                          type="button"
                          onClick={() => onCampaign(c.slug)}
                          className="block text-left underline underline-offset-2 hover:text-foreground"
                        >
                          {c.display_name || c.slug}
                        </button>
                      ))
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Per-run cap</TableCell>
                  <TableCell>
                    {t.cap != null
                      ? `${t.cap.toLocaleString()} — a bigger selection skips the run and alerts`
                      : '—'}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Candidates now</TableCell>
                  <TableCell>{t.candidates.toLocaleString()}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Fire log</TableCell>
                  <TableCell>
                    {t.fires_sent.toLocaleString()} fired · {t.fires_absorbed.toLocaleString()}{' '}
                    absorbed
                    {t.fires_failed > 0 && (
                      <span className="text-destructive">
                        {' '}
                        · {t.fires_failed.toLocaleString()} failed
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Last fired</TableCell>
                  <TableCell>
                    {t.last_fired_at ? (
                      <>
                        {formatPacific(t.last_fired_at)}{' '}
                        <span className="text-muted-foreground">
                          ({relativeFrom(t.last_fired_at)})
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => onTab(v as TriggerTab)}>
        <TabsList>
          {TRIGGER_TABS.map(({ key, label }) => (
            <TabsTrigger key={key} value={key}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'overview' &&
        (t.in_hub ? (
          <>
            <Card>
              <CardContent className="pt-6">
                <div className="grid gap-6">
                  <BulletBlock
                    title="Selection logic"
                    lines={t.logic ?? []}
                    empty="No logic summary recorded for this trigger yet."
                  />
                  <BulletBlock
                    title="Webhook payload"
                    lines={t.payload ?? []}
                    empty="No payload contract recorded for this trigger yet."
                  />
                </div>
              </CardContent>
            </Card>
            {t.campaigns.map((c) => (
              <SampleSender key={c.slug} slug={c.slug} />
            ))}
          </>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>This key does not exist in the hub</AlertTitle>
            <AlertDescription>
              There is no selection logic or payload and it never fires. Fix the trigger key on the
              campaign&apos;s Registration tab.
            </AlertDescription>
          </Alert>
        ))}
      {tab === 'preview' && <TriggerAffected t={t} />}
    </div>
  );
}

export default function TriggersPanel({ onSelect }: { onSelect: (slug: string) => void }) {
  const [{ tstat, tq, tsel, ttab, twin }, setUrl] = useUrlFilters(
    {
      tstat: '',
      tq: '',
      tsel: '',
      ttab: '',
      /* owned by TriggerAffected; declared here so leaving a drilldown
         clears it instead of leaking last-90-days into the next one */
      twin: '',
    },
    ['tsel', 'ttab']
  );
  void twin;
  const filter: TriggerState = tstat === 'disabled' || tstat === 'draft' ? tstat : 'enabled';
  const tab: TriggerTab = ttab === 'preview' ? 'preview' : 'overview';

  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const isAdmin = role === 'admin';

  const list = useQuery({
    queryKey: ['triggers'],
    queryFn: () => api.get<TriggersResponse>('/api/triggers'),
    staleTime: 60_000,
  });

  const all = list.data?.triggers ?? [];
  const hubKilled = list.data?.hub_killed ?? null;

  const kill = useKillMutation();
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [confirmLiftAll, setConfirmLiftAll] = useState(false);
  const [stopReason, setStopReason] = useState('');
  /* Per-row emergency stop — the trigger awaiting confirmation, if any. */
  const [rowKill, setRowKill] = useState<TriggerRow | null>(null);
  const [rowReason, setRowReason] = useState('');
  const setEnabled = useEnabledMutation();
  const stateBusy = useStateBusy(setEnabled);
  /* Per-row enable — the trigger awaiting confirmation, if any. */
  const [rowEnable, setRowEnable] = useState<TriggerRow | null>(null);
  const [enableReason, setEnableReason] = useState('');
  const [enableAbsorb, setEnableAbsorb] = useState(true);

  if (tsel) {
    /* tsel carries the registered campaign SLUG when one exists (the name
       people actually recognize in a shared link), with the raw trigger key
       accepted too — older links and campaign-less triggers still resolve. */
    const t = all.find((x) => x.key === tsel || x.campaigns.some((c) => c.slug === tsel));
    if (list.isPending) return <TriggerDrilldownSkeleton />;
    if (!t)
      return (
        <Alert variant="destructive">
          <AlertTitle>Unknown trigger</AlertTitle>
          <AlertDescription>
            No trigger named <code>{tsel}</code> exists —{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setUrl({ tsel: '', ttab: '', twin: '' })}
            >
              back to the list
            </button>
            .
          </AlertDescription>
        </Alert>
      );
    return (
      <TriggerDrilldown
        t={t}
        tab={tab}
        onTab={(next) => setUrl({ ttab: next === 'overview' ? '' : next })}
        onBack={() => setUrl({ tsel: '', ttab: '', twin: '' })}
        onCampaign={(slug) => onSelect(slug)}
        hubDryRun={list.data?.hub_dry_run ?? null}
      />
    );
  }

  /* "Not in hub" is a misconfiguration, not a status — it shows under both
     filters so it can't hide. */
  const q = tq.trim().toLowerCase();
  const matches = (t: TriggerRow) =>
    !q ||
    t.key.toLowerCase().includes(q) ||
    (t.label ?? '').toLowerCase().includes(q) ||
    t.campaigns.some(
      (c) => c.slug.toLowerCase().includes(q) || (c.display_name ?? '').toLowerCase().includes(q)
    );
  /* Enabled = will SEND on the next run; everything else (toggle off,
     code gate closed, emergency-stopped) is Disabled. Not-in-hub shows
     under both — a misconfiguration, not a status. */
  const enabled = all.filter((t) => (!t.in_hub || isLive(t)) && matches(t));
  const disabled = all.filter(
    (t) => (!t.in_hub || (!isLive(t) && t.state !== 'draft')) && matches(t)
  );
  const draft = all.filter((t) => t.in_hub && t.state === 'draft' && matches(t));
  /* No explicit choice in the URL + nothing live yet (the dry-run phase)
     → open on Disabled rather than an empty Enabled tab. */
  const effectiveFilter =
    tstat === '' && enabled.length === 0 && disabled.length > 0 ? 'disabled' : filter;
  const tabRows = { enabled, disabled, draft }[effectiveFilter];
  /* A row that just changed state belongs to a different tab the moment it
     flips — but yanking it out from under the click is exactly what makes a
     change feel like it didn't take. Hold it in its own position, spinner
     and all, until its refresh lands and it moves on its own. The tab counts
     above stay honest; only this list pins. */
  const pinnedKey = stateBusy.savingKey ?? stateBusy.refreshingKey;
  const tabKeys = new Set(tabRows.map((t) => t.key));
  const rows =
    pinnedKey && !tabKeys.has(pinnedKey)
      ? all.filter((t) => tabKeys.has(t.key) || (t.key === pinnedKey && matches(t)))
      : tabRows;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Warehouse triggers</CardTitle>
        <CardDescription>
          The trigger-hub jobs that actually send the webhooks: each one is a BigQuery selection
          that finds matching customers and POSTs one webhook per person into its campaign&apos;s
          [1/2] relay. Click a trigger for its selection logic, webhook payload and the customers it
          would affect. The authoritative SQL, caps and on/off flags live in the hub — this view is
          read-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the triggers</AlertTitle>
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {list.isPending && <TriggerListSkeleton />}
        {list.data && (
          <>
            <HubDryRunBanner data={list.data} />
            {setEnabled.isSuccess && setEnabled.data.state === 'enabled' && (
              <Alert>
                <AlertTitle>
                  {setEnabled.data.trigger_key} enabled
                  {setEnabled.data.absorbed != null
                    ? ` — ${setEnabled.data.absorbed.toLocaleString()} absorbed as baseline`
                    : ''}
                </AlertTitle>
                <AlertDescription>
                  Sends start on the hub&apos;s next hourly run{' '}
                  {list.data.hub_dry_run ? '(once the hub-wide dry run is lifted)' : ''}.
                </AlertDescription>
              </Alert>
            )}
            {setEnabled.isError && (
              <Alert variant="destructive">
                <AlertTitle>Enabled toggle update failed</AlertTitle>
                <AlertDescription>{(setEnabled.error as Error).message}</AlertDescription>
              </Alert>
            )}
            <ConfirmDialog
              open={rowEnable !== null}
              onOpenChange={(o) => {
                if (!o) setRowEnable(null);
              }}
              title={`Enable ${rowEnable?.label ?? rowEnable?.key ?? ''} — start sending?`}
              confirmLabel={
                enableAbsorb && (rowEnable?.candidates ?? 0) > 0
                  ? `Absorb ${rowEnable?.candidates.toLocaleString()} and enable`
                  : 'Enable sends'
              }
              description={
                rowEnable && (
                  <EnableDescription
                    t={rowEnable}
                    hubDryRun={list.data.hub_dry_run}
                    reason={enableReason}
                    onReason={setEnableReason}
                    absorb={enableAbsorb}
                    onAbsorb={setEnableAbsorb}
                  />
                )
              }
              onConfirm={() => {
                if (rowEnable)
                  setEnabled.mutate({
                    key: rowEnable.key,
                    state: 'enabled',
                    reason: enableReason.trim(),
                    absorb: enableAbsorb && rowEnable.candidates > 0,
                  });
                setRowEnable(null);
              }}
            />
            <ConfirmDialog
              open={confirmStopAll}
              onOpenChange={setConfirmStopAll}
              destructive
              title="Emergency-stop ALL sends?"
              confirmLabel="Stop all sends"
              description={
                <span className="grid gap-3">
                  <span>
                    The hub will skip every trigger on every run until the switch is deliberately
                    lifted. This only stops sends — it cannot send anything.
                  </span>
                  <Input
                    placeholder="Reason (optional, shown in the audit trail)"
                    maxLength={300}
                    value={stopReason}
                    onChange={(e) => setStopReason(e.target.value)}
                  />
                </span>
              }
              onConfirm={() => kill.mutate({ key: 'all', killed: true, reason: stopReason.trim() })}
            />
            <ConfirmDialog
              open={confirmLiftAll}
              onOpenChange={setConfirmLiftAll}
              destructive
              title="Lift the hub-wide emergency stop?"
              confirmLabel="Lift emergency stop"
              description="Lifting re-allows sends for every enabled trigger that isn't individually emergency-disabled."
              onConfirm={() => kill.mutate({ key: 'all', killed: false })}
            />
            <ConfirmDialog
              open={!!rowKill}
              onOpenChange={(o) => {
                if (!o) setRowKill(null);
              }}
              destructive
              title={`Emergency-disable ${rowKill?.label ?? rowKill?.key ?? ''}?`}
              confirmLabel="Emergency disable"
              description={
                <span className="grid gap-3">
                  <span>
                    The hub will skip this trigger on every run until the switch is deliberately
                    lifted. This only stops sends — it cannot send anything.
                  </span>
                  <Input
                    placeholder="Reason (optional, shown in the audit trail)"
                    maxLength={300}
                    value={rowReason}
                    onChange={(e) => setRowReason(e.target.value)}
                  />
                </span>
              }
              onConfirm={() => {
                if (rowKill)
                  kill.mutate({ key: rowKill.key, killed: true, reason: rowReason.trim() });
              }}
            />
            {hubKilled && (
              <Alert variant="destructive">
                <AlertTitle>All sends are emergency-stopped</AlertTitle>
                <AlertDescription>
                  <span className="grid gap-2">
                    <span>
                      The hub skips every trigger on every run.{' '}
                      {killDetail(hubKilled) ?? 'No reason recorded.'}
                    </span>
                    {isAdmin ? (
                      <span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={kill.isPending}
                          onClick={() => setConfirmLiftAll(true)}
                        >
                          Lift emergency stop
                        </Button>
                      </span>
                    ) : (
                      <span>Lifting an emergency stop is admin-only.</span>
                    )}
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {kill.isError && (
              <Alert variant="destructive">
                <AlertTitle>Kill-switch update failed</AlertTitle>
                <AlertDescription>{(kill.error as Error).message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                value={effectiveFilter}
                onValueChange={(v) =>
                  setUrl({ tstat: v === 'disabled' || v === 'draft' ? v : 'enabled' })
                }
              >
                <TabsList>
                  <TabsTrigger value="enabled">
                    Enabled
                    <Badge variant="secondary" className="ml-1.5 px-1.5">
                      {enabled.length}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="disabled">
                    Disabled
                    <Badge variant="secondary" className="ml-1.5 px-1.5">
                      {disabled.length}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="draft">
                    Draft
                    <Badge variant="secondary" className="ml-1.5 px-1.5">
                      {draft.length}
                    </Badge>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Input
                className="w-64"
                placeholder="Search triggers…"
                value={tq}
                onChange={(e) => setUrl({ tq: e.target.value })}
              />
              {/* Every campaign in one workbook — a worksheet per campaign,
                  both windows stacked under a `window` column. */}
              <ExportExcelButton
                label="Export All Campaigns Excel"
                path={`/api/triggers/export?days=${HISTORY_DAYS}`}
              />
              {canEdit && !hubKilled && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="ml-auto"
                  disabled={kill.isPending}
                  onClick={() => {
                    setStopReason('');
                    setConfirmStopAll(true);
                  }}
                >
                  Emergency stop all sends
                </Button>
              )}
            </div>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-52">Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead className="text-right">Cap</TableHead>
                    <TableHead className="text-right">Candidates</TableHead>
                    <TableHead className="text-right">Fire log</TableHead>
                    <TableHead>Last fired</TableHead>
                    {canEdit && <TableHead className="w-32" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={canEdit ? 7 : 6}
                        className="h-16 text-center text-muted-foreground"
                      >
                        {q ? 'Nothing matches this search.' : `No ${effectiveFilter} triggers.`}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((t) => (
                    <TableRow
                      key={t.key}
                      onClick={() =>
                        setUrl({ tsel: t.campaigns[0]?.slug ?? t.key, ttab: '', twin: '' })
                      }
                      className="cursor-pointer"
                    >
                      <TableCell className="align-top" onClick={(e) => e.stopPropagation()}>
                        <StatusControl
                          t={t}
                          canEdit={canEdit}
                          isAdmin={isAdmin}
                          busy={setEnabled.isPending}
                          pending={stateBusy.savingKey === t.key ? stateBusy.savingState : null}
                          refreshing={stateBusy.refreshingKey === t.key}
                          onEnable={() => {
                            setEnableReason('');
                            setEnableAbsorb(true);
                            setRowEnable(t);
                          }}
                          onChange={(state) => setEnabled.mutate({ key: t.key, state })}
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="grid grid-cols-[5rem_1fr] gap-x-1.5 gap-y-0.5">
                          <span className="text-right font-sans text-xs leading-5 font-medium text-muted-foreground">
                            NAME:
                          </span>
                          <span className="text-sm font-medium whitespace-nowrap">
                            {t.label ?? '—'}
                          </span>
                          <span className="text-right font-sans text-xs leading-4 font-medium text-muted-foreground">
                            TRIGGER:
                          </span>
                          <code className="text-xs text-muted-foreground">{t.key}</code>
                          <span className="text-right font-sans text-xs leading-5 font-medium text-muted-foreground">
                            CAMPAIGN:
                          </span>
                          <span>
                            {t.campaigns.length === 0 ? (
                              <span className="text-sm text-muted-foreground">
                                — none registered
                              </span>
                            ) : (
                              t.campaigns.map((c) => (
                                <span key={c.slug} className="block text-sm whitespace-nowrap">
                                  {c.display_name || c.slug}
                                </span>
                              ))
                            )}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right align-top text-sm">{t.cap ?? '—'}</TableCell>
                      <TableCell className="text-right align-top text-sm">
                        {t.candidates.toLocaleString()}
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        <FireLogCell t={t} />
                      </TableCell>
                      <TableCell className="align-top text-sm whitespace-nowrap">
                        {t.last_fired_at ? (
                          <>
                            <div>{formatPacific(t.last_fired_at)}</div>
                            <div className="text-xs text-muted-foreground">
                              {relativeFrom(t.last_fired_at)}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      {canEdit && (
                        <TableCell className="align-top">
                          {t.in_hub && !t.killed && (
                            <Button
                              variant="destructive"
                              size="sm"
                              className="text-xs"
                              disabled={kill.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRowReason('');
                                setRowKill(t);
                              }}
                            >
                              Emergency stop
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Fired = webhooks actually sent and accepted. Absorbed = log rows written without a
              send: bootstrap baselines (everyone who already matched when the trigger was stood
              up), suppressions and poller-cutover history. Failed appears only when a post errored
              — those retry on the next hourly run. A trigger with no campaign registered fires into
              a webhook nobody is validating; a campaign whose key is not in the hub never fires at
              all and shows under both filters.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
