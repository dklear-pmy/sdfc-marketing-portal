/* Affected customers tab: who this campaign's warehouse trigger actually
   selected, newest first, with the exact payload the inbound webhook
   received. Client-facing loop (2026-08-05 request): watch a payload land on
   the campaign's webhook in CIO, then confirm the same person and data here.
   Reads /api/slugs/{slug}/affected — the cio-trigger-hub fire log filtered by
   the registry's trigger key; the API resolves the key, so a campaign with
   none registered comes back as an empty page with trigger_key=null. */

import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AffectedCustomersPage } from '@/lib/api';
import { useUrlFilters } from '@/lib/urlState';
import { formatPacific, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HoverTip } from '@/components/ui/hover-tip';
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

const statusVariant = (status: string): 'default' | 'destructive' | 'secondary' | 'outline' => {
  if (status === 'sent') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'suppressed') return 'secondary';
  return 'outline'; // baseline + anything the hub grows later
};

export function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function AffectedCustomersTab({ slug }: { slug: string }) {
  const [{ aq, astatus, aoffset }, setUrl] = useUrlFilters({ aq: '', astatus: '', aoffset: 0 });
  const [qInput, setQInput] = useState(aq);
  useEffect(() => setQInput(aq), [aq]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['affected', slug, aq, astatus, aoffset],
    queryFn: () =>
      api.get<AffectedCustomersPage>(
        `/api/slugs/${encodeURIComponent(slug)}/affected?limit=${PAGE}&offset=${aoffset}` +
          (aq ? `&q=${encodeURIComponent(aq)}` : '') +
          (astatus ? `&status=${encodeURIComponent(astatus)}` : '')
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  const page = list.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Have fired</CardTitle>
        <CardDescription>
          Every fire of this campaign&apos;s warehouse trigger, newest first — the person the logic
          selected and the exact payload the inbound webhook received.
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
            <AlertTitle>Couldn&apos;t load affected customers</AlertTitle>
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {list.isPending && <Skeleton className="h-64" />}
        {page && !page.trigger_key && (
          <Alert>
            <AlertTitle>No trigger key registered</AlertTitle>
            <AlertDescription>
              This campaign isn&apos;t mapped to a warehouse trigger yet — set &quot;Trigger key
              (trigger hub)&quot; on the Registration tab and the fire log will appear here.
            </AlertDescription>
          </Alert>
        )}
        {page && page.trigger_key && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setUrl({ aq: qInput.trim(), aoffset: 0 });
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
              {page.statuses.length > 1 && (
                <Tabs
                  value={astatus || 'all'}
                  onValueChange={(v) => setUrl({ astatus: v === 'all' ? '' : v, aoffset: 0 })}
                >
                  <TabsList>
                    <TabsTrigger value="all">All</TabsTrigger>
                    {page.statuses.map((s) => (
                      <TabsTrigger key={s} value={s}>
                        {s}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
            </div>

            <div
              className={cn('overflow-x-auto rounded-md border', list.isFetching && 'opacity-60')}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fired</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-24">Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                        {aq || astatus
                          ? 'Nothing matches these filters.'
                          : 'No fires recorded for this trigger yet.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => {
                    const key = `${r.dedup_key}-${r.fired_at}`;
                    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
                    return (
                      <Fragment key={key}>
                        <TableRow>
                          <TableCell className="whitespace-nowrap">
                            <div>{formatPacific(r.fired_at)}</div>
                            <div className="text-xs text-muted-foreground">
                              {relativeFrom(r.fired_at)}
                            </div>
                          </TableCell>
                          <TableCell>
                            {name && <div>{name}</div>}
                            <div className={cn(!name && 'mt-0', 'text-xs text-muted-foreground')}>
                              {r.email ?? '—'}
                            </div>
                          </TableCell>
                          <TableCell>
                            {r.status === 'failed' && r.error ? (
                              <HoverTip content={`${r.status_code ?? '—'}: ${r.error}`}>
                                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                              </HoverTip>
                            ) : (
                              <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                            )}
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
                            <TableCell colSpan={4} className="bg-muted/40">
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
                {rows.length === 0 ? '0' : `${aoffset + 1}–${aoffset + rows.length}`} of{' '}
                {total.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aoffset === 0}
                  onClick={() => setUrl({ aoffset: Math.max(0, aoffset - PAGE) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aoffset + PAGE >= total}
                  onClick={() => setUrl({ aoffset: aoffset + PAGE })}
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
