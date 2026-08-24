/* Trigger Manager (its own nav area): the warehouse triggers that actually
   send the webhooks. Each row is a cio-trigger-hub trigger — a BigQuery
   selection that finds matching customers and POSTs one webhook per person
   into its campaign's [1/2] relay. Joined against the slug registry so a
   key mismatch is visible from either side: a registry key the hub doesn't
   carry ("Not in hub" — fires nothing, ever) or a hub trigger no campaign
   is registered to (fires into a webhook nobody validates). Read-only;
   trigger SQL, caps and enabled flags live in the hub's triggers.py.

   Mirrors the campaigns area's shape: a searchable list (Enabled/Disabled
   filter, default enabled; "Not in hub" errors surface under BOTH filters
   so a misconfiguration can never hide), and a per-trigger drilldown with
   tabs — Overview (facts, selection logic, payload contract) and Matching
   Customers (live next-run selection + trailing-90-day history). */

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TriggerKillInfo, type TriggerRow, type WouldFirePage } from '@/lib/api';
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

function statusBadge(t: TriggerRow) {
  if (!t.in_hub) return <Badge variant="destructive">Not in hub</Badge>;
  if (t.killed) return <Badge variant="destructive">Emergency off</Badge>;
  return t.enabled ? (
    <Badge variant="default">Enabled</Badge>
  ) : (
    <Badge variant="secondary">Disabled</Badge>
  );
}

interface TriggersResponse {
  triggers: TriggerRow[];
  hub_killed: TriggerKillInfo | null;
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
              <TableHead className="w-24">Status</TableHead>
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
}: {
  t: TriggerRow;
  tab: TriggerTab;
  onTab: (tab: TriggerTab) => void;
  onBack: () => void;
  onCampaign: (slug: string) => void;
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
              {statusBadge(t)}
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
  const filter = tstat === 'disabled' ? 'disabled' : 'enabled';
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
  const enabled = all.filter((t) => (!t.in_hub || t.enabled === true) && matches(t));
  const disabled = all.filter((t) => (!t.in_hub || t.enabled === false) && matches(t));
  const rows = filter === 'enabled' ? enabled : disabled;

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
                value={filter}
                onValueChange={(v) => setUrl({ tstat: v === 'disabled' ? 'disabled' : '' })}
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
                    <TableHead className="w-24">Status</TableHead>
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
                        {q ? 'Nothing matches this search.' : `No ${filter} triggers.`}
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
                      <TableCell className="align-top">{statusBadge(t)}</TableCell>
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
