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
import { formatPacific, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { prettyPayload } from '@/components/AffectedCustomers';

const PAGE = 20;

export function WouldFireTab({ slug }: { slug: string }) {
  const [{ pq, poffset }, setUrl] = useUrlFilters({ pq: '', poffset: 0 });
  const [qInput, setQInput] = useState(pq);
  useEffect(() => setQInput(pq), [pq]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['would-fire', slug, pq, poffset],
    queryFn: () =>
      api.get<WouldFirePage>(
        `/api/slugs/${encodeURIComponent(slug)}/preview?limit=${PAGE}&offset=${poffset}` +
          (pq ? `&q=${encodeURIComponent(pq)}` : '')
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  const page = list.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const overCap = !pq && page?.cap != null && total > page.cap;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Would fire</CardTitle>
        <CardDescription>
          Everyone this campaign&apos;s trigger logic selects right now who hasn&apos;t already
          fired — the exact people (and payloads) the hub would send to the inbound webhook when it
          runs armed. Evaluated live against the warehouse.
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
        {list.isPending && <Skeleton className="h-64" />}
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
            {overCap && (
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
              {!pq && !overCap && (
                <span className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{total.toLocaleString()}</span>{' '}
                  {total === 1 ? 'customer' : 'customers'} currently selected.
                </span>
              )}
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
                              <pre className="max-h-72 overflow-auto p-1 text-xs break-all whitespace-pre-wrap">
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
                {rows.length === 0 ? '0' : `${poffset + 1}–${poffset + rows.length}`} of{' '}
                {total.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={poffset === 0}
                  onClick={() => setUrl({ poffset: Math.max(0, poffset - PAGE) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={poffset + PAGE >= total}
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
