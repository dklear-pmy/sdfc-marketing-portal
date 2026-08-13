/* Triggers area of the Campaign Tester: the warehouse triggers that actually
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
import { useQuery } from '@tanstack/react-query';
import { api, type TriggerRow, type WouldFirePage } from '@/lib/api';
import { useUrlFilters } from '@/lib/urlState';
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

function statusBadge(t: TriggerRow) {
  if (!t.in_hub) return <Badge variant="destructive">Not in hub</Badge>;
  return t.enabled ? (
    <Badge variant="default">Enabled</Badge>
  ) : (
    <Badge variant="secondary">Disabled</Badge>
  );
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

/* Who the trigger would affect: the live next-run selection, or every event
   of the trailing 90 days from the history table function. Same data the
   campaign drilldown's Matching Customers tab shows, addressed by trigger
   key so it works even for a trigger with no registered campaign. Strictly
   preview — the portal never fires a production webhook. */
function TriggerAffected({ t }: { t: TriggerRow }) {
  const [win, setWin] = useState<'next' | 'history'>('next');
  const [offset, setOffset] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['trigger-preview', t.key, win, offset],
    queryFn: () =>
      api.get<WouldFirePage>(
        `/api/triggers/${encodeURIComponent(t.key)}/preview?limit=${AFFECTED_PAGE}&offset=${offset}` +
          (win === 'history' ? `&days=${HISTORY_DAYS}` : '')
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  const page = list.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const overCap = win === 'next' && page?.cap != null && total > page.cap;

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
        <Tabs
          value={win}
          onValueChange={(v) => {
            setWin(v === 'history' ? 'history' : 'next');
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
        {list.isPending && <Skeleton className="h-40" />}
        {win === 'history' && page?.history_available === false && (
          <Alert>
            <AlertTitle>No history view for this trigger yet</AlertTitle>
            <AlertDescription>
              The history table function doesn&apos;t carry this trigger&apos;s branch — only the
              live next-run view is available. History exists for the SF membership triggers
              (supporters and premium).
            </AlertDescription>
          </Alert>
        )}
        {overCap && (
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
        {page && !(win === 'history' && page.history_available === false) && (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{total.toLocaleString()}</span>{' '}
              {win === 'next'
                ? `${total === 1 ? 'customer' : 'customers'} currently selected.`
                : `matching ${total === 1 ? 'event' : 'events'} in the last ${HISTORY_DAYS} days.`}
            </p>
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
  return (
    <div className="grid gap-6">
      <div>
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back to triggers
        </Button>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-xl">{t.label ?? t.key}</CardTitle>
            {statusBadge(t)}
          </div>
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
  const [{ tstat, tq, tsel, ttab }, setUrl] = useUrlFilters(
    {
      tstat: '',
      tq: '',
      tsel: '',
      ttab: '',
    },
    ['tsel', 'ttab']
  );
  const filter = tstat === 'disabled' ? 'disabled' : 'enabled';
  const tab: TriggerTab = ttab === 'preview' ? 'preview' : 'overview';

  const list = useQuery({
    queryKey: ['triggers'],
    queryFn: () => api.get<{ triggers: TriggerRow[] }>('/api/triggers'),
    staleTime: 60_000,
  });

  const all = list.data?.triggers ?? [];

  if (tsel) {
    const t = all.find((x) => x.key === tsel);
    if (list.isPending) return <Skeleton className="h-64" />;
    if (!t)
      return (
        <Alert variant="destructive">
          <AlertTitle>Unknown trigger</AlertTitle>
          <AlertDescription>
            No trigger named <code>{tsel}</code> exists —{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setUrl({ tsel: '', ttab: '' })}
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
        onBack={() => setUrl({ tsel: '', ttab: '' })}
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
        {list.isPending && <Skeleton className="h-48" />}
        {list.data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                value={filter}
                onValueChange={(v) => setUrl({ tstat: v === 'disabled' ? 'disabled' : '' })}
              >
                <TabsList>
                  <TabsTrigger value="enabled">Enabled ({enabled.length})</TabsTrigger>
                  <TabsTrigger value="disabled">Disabled ({disabled.length})</TabsTrigger>
                </TabsList>
              </Tabs>
              <Input
                className="w-64"
                placeholder="Search triggers…"
                value={tq}
                onChange={(e) => setUrl({ tq: e.target.value })}
              />
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
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-16 text-center text-muted-foreground">
                        {q ? 'Nothing matches this search.' : `No ${filter} triggers.`}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((t) => (
                    <TableRow
                      key={t.key}
                      onClick={() => setUrl({ tsel: t.key, ttab: '' })}
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
