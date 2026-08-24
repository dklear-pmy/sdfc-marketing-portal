/* Would-fire preview tab: who this campaign's warehouse trigger WOULD select
   on the trigger hub's next run — evaluated live right now via
   customerio_state.vw_campaign_would_fire (the hub's own candidate SQL minus
   everyone already in the fire log). The forward half of the client's
   validation loop: this list is "who gets the email if the hub runs now";
   the Affected customers tab is "who it actually fired for". When the count
   exceeds the trigger's per-run safety cap, the hub would skip-and-alert
   rather than send — surfaced here so nobody arms a trigger into a breaker
   trip. Reads /api/slugs/{slug}/preview. */

import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type WouldFirePage } from '@/lib/api';
import { useUrlFilters } from '@/lib/urlState';
import { formatPacific, prettyPayload, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportExcelButton } from '@/components/ExportExcel';
import { PreviewCountSkeleton, PreviewTableSkeleton } from '@/components/PreviewSkeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const PAGE = 20;
/* Same bound as TriggersPanel: fail fast under the API's 25s result timeout so
   react-query retries instead of leaving the skeleton open-ended. */
const PREVIEW_TIMEOUT_MS = 20_000;

const HISTORY_DAYS = 90;

export function WouldFireTab({ slug }: { slug: string }) {
  const [{ pq, poffset, pwin }, setUrl] = useUrlFilters({ pq: '', poffset: 0, pwin: 'next' }, [
    'pwin',
  ]);
  const win = pwin === 'history' ? 'history' : 'next';
  const [qInput, setQInput] = useState(pq);
  useEffect(() => setQInput(pq), [pq]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['would-fire', slug, pq, poffset, win],
    queryFn: () =>
      api.get<WouldFirePage>(
        `/api/slugs/${encodeURIComponent(slug)}/preview?limit=${PAGE}&offset=${poffset}` +
          (pq ? `&q=${encodeURIComponent(pq)}` : '') +
          (win === 'history' ? `&days=${HISTORY_DAYS}` : ''),
        { timeoutMs: PREVIEW_TIMEOUT_MS }
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  const page = list.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const overCap = win === 'next' && !pq && page?.cap != null && total > page.cap;
  /* isPlaceholderData = the rows on screen belong to the previous window,
     page, or search — not the query now in flight. Treating that as loading
     is what stops a window switch from showing the old window's answer for
     the several seconds the warehouse takes. */
  const loading = list.isPending || list.isPlaceholderData;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matching Customers</CardTitle>
        <CardDescription>
          {win === 'next'
            ? "Everyone this campaign's trigger logic selects right now who hasn't already fired — " +
              'the exact people (and payloads) the hub would send to the inbound webhook when it ' +
              'runs armed. Evaluated live against the warehouse.'
            : `Every event this campaign's trigger would have fired on in the last ${HISTORY_DAYS} days, ` +
              'including ones already fired. Evaluated live against the warehouse.'}{' '}
          <strong className="font-medium text-foreground">
            These are real fans with real addresses
          </strong>{' '}
          — this list is preview-only and the portal never fires a production webhook. To exercise
          these events safely, use the shadow runs on the Test runs tab: same events, recipients
          rewritten to the sink.
          {page?.trigger_key && (
            <>
              {' '}
              Trigger:{' '}
              {page.trigger_label ? (
                <>
                  {page.trigger_label} <code className="text-xs">({page.trigger_key})</code>
                </>
              ) : (
                <code className="text-xs">{page.trigger_key}</code>
              )}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the preview</AlertTitle>
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {list.isPending && (
          <>
            <PreviewCountSkeleton />
            <PreviewTableSkeleton />
          </>
        )}
        {page && !page.trigger_key && (
          <Alert>
            <AlertTitle>No trigger key registered</AlertTitle>
            <AlertDescription>
              This campaign isn&apos;t mapped to a warehouse trigger yet — set &quot;Trigger key
              (trigger hub)&quot; on the Registration tab and the preview will appear here.
            </AlertDescription>
          </Alert>
        )}
        {page && page.trigger_key && (
          <>
            {/* Whole-campaign export: BOTH windows in one file, as worksheet
                tabs — distinct from the per-window button below the tabs. */}
            <div className="flex justify-start">
              <ExportExcelButton
                label="Export Campaign Excel"
                path={
                  `/api/slugs/${encodeURIComponent(slug)}/preview/export?windows=all&days=${HISTORY_DAYS}` +
                  (pq ? `&q=${encodeURIComponent(pq)}` : '')
                }
              />
            </div>
            <Tabs
              value={win}
              onValueChange={(v) =>
                setUrl({ pwin: v === 'history' ? 'history' : 'next', poffset: 0 })
              }
            >
              <TabsList>
                <TabsTrigger value="next">Next Run</TabsTrigger>
                <TabsTrigger value="history">Last {HISTORY_DAYS} Days</TabsTrigger>
              </TabsList>
            </Tabs>
            {!loading && win === 'history' && page.history_available === false && (
              <Alert>
                <AlertTitle>No history view for this trigger yet</AlertTitle>
                <AlertDescription>
                  The history table function doesn&apos;t carry this trigger&apos;s branch — only
                  the live next-run view is available. History exists for the SF membership triggers
                  (supporters and premium).
                </AlertDescription>
              </Alert>
            )}
            {page.enabled === false && (
              <Alert>
                <AlertTitle>Trigger not enabled in the hub yet</AlertTitle>
                <AlertDescription>
                  This list demonstrates the drafted selection logic — who would receive the email
                  and with what payload. Nothing sends until the trigger is enabled in the hub and
                  the hub is armed.
                </AlertDescription>
              </Alert>
            )}
            {!loading && overCap && (
              <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-500 [&>div]:text-amber-700/90 dark:[&>div]:text-amber-500/90">
                <AlertTitle>
                  {total.toLocaleString()} exceeds the per-run safety cap (
                  {page.cap!.toLocaleString()})
                </AlertTitle>
                <AlertDescription>
                  The hub would skip this run and alert instead of sending. A backlog this size
                  usually means the trigger needs its state re-baselined (backlog absorbed) before
                  arming.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setUrl({ pq: qInput.trim(), poffset: 0 });
                }}
              >
                <Input
                  className="w-64"
                  placeholder="Search name or email…"
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                />
                <Button type="submit" variant="outline">
                  Search
                </Button>
              </form>
              {loading && <PreviewCountSkeleton />}
              {!loading && !pq && !overCap && (
                <span className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{total.toLocaleString()}</span>{' '}
                  {win === 'next'
                    ? `${total === 1 ? 'customer' : 'customers'} currently selected.`
                    : `matching ${total === 1 ? 'event' : 'events'} in the last ${HISTORY_DAYS} days.`}
                </span>
              )}
              <span className="ml-auto">
                <ExportExcelButton
                  path={
                    `/api/slugs/${encodeURIComponent(slug)}/preview/export` +
                    (win === 'history' ? `?days=${HISTORY_DAYS}` : '') +
                    (pq ? `${win === 'history' ? '&' : '?'}q=${encodeURIComponent(pq)}` : '')
                  }
                  disabled={loading || total === 0}
                />
              </span>
            </div>

            {loading && <PreviewTableSkeleton />}
            <div
              className={cn(
                'overflow-x-auto rounded-md border',
                list.isFetching && !loading && 'opacity-60',
                loading && 'hidden'
              )}
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
                        {pq
                          ? 'Nothing matches this search.'
                          : 'No customers currently match this trigger’s logic.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => {
                    const key = `${r.dedup_key}`;
                    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
                    return (
                      <Fragment key={key}>
                        <TableRow>
                          <TableCell className="whitespace-nowrap">
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
                            {name && <div>{name}</div>}
                            <div className="text-xs text-muted-foreground">{r.email ?? '—'}</div>
                          </TableCell>
                          <TableCell>
                            {r.payload_json ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setOpenKey(openKey === key ? null : key)}
                              >
                                {openKey === key ? 'Hide' : 'View'}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {openKey === key && r.payload_json && (
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

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {loading ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <>
                    {rows.length === 0 ? '0' : `${poffset + 1}–${poffset + rows.length}`} of{' '}
                    {total.toLocaleString()}
                  </>
                )}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || poffset === 0}
                  onClick={() => setUrl({ poffset: Math.max(0, poffset - PAGE) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || poffset + PAGE >= total}
                  onClick={() => setUrl({ poffset: poffset + PAGE })}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
