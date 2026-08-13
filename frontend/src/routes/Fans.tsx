import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { oneOf, useUrlFilters } from '@/lib/urlState';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  api,
  type ActivitiesPage,
  type AttrComparison,
  type AttrStatus,
  type CioActivity,
  type CioMessage,
  type CustomerLookup,
  type FanLedgerPage,
  type FanListPage,
  type LedgerEvent,
  type LedgerStatus,
  type MessagesPage,
} from '@/lib/api';
import { formatUnix, formatPacific, humanizeAttr, relativeFrom } from '@/lib/format';
import { ledgerEventDetail as eventDetailLine } from '@/lib/ledgerDetail';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { cn } from '@/lib/utils';

export default function Fans() {
  /* ?email=… is the deep link — from the Fan Ledger, from a teammate, or from
     picking a row in the browse list below. The URL is the single source of
     truth for which fan is open; the box holds an unsubmitted draft. */
  const [url, setUrl] = useUrlFilters({ email: '' }, ['email']);
  const submitted = url.email.trim().toLowerCase() || null;
  const [email, setEmail] = useState(url.email);
  useEffect(() => setEmail(url.email), [url.email]);

  const lookup = useQuery<CustomerLookup>({
    queryKey: ['customer-lookup', submitted],
    queryFn: () => api.get(`/api/customers/lookup?email=${encodeURIComponent(submitted!)}`),
    enabled: !!submitted,
    staleTime: 30_000,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = email.trim().toLowerCase();
    if (v) setUrl({ email: v });
  }

  return (
    <div className="grid gap-6">
      {submitted && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setUrl({ email: '' })}>
            ← Return to Fan Activity
          </Button>
        </div>
      )}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Fans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything we know about a fan in one place — their live Customer.io profile, our
          warehouse data and their full history. Look one up by email, or browse the most recently
          active fans below.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-64 flex-1 gap-1.5">
              <Label htmlFor="cust-email">Email</Label>
              <Input
                id="cust-email"
                type="email"
                required
                placeholder="e.g. fan@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={lookup.isFetching}>
              {lookup.isFetching ? 'Looking up…' : 'Look up'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {lookup.isError && (
        <Alert variant="destructive">
          <AlertTitle>Lookup failed</AlertTitle>
          <AlertDescription>{(lookup.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {lookup.isFetching && (
        <div className="grid gap-4 2xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {lookup.data && !lookup.isFetching && <LookupResult data={lookup.data} />}

      {/* Browse list only on the landing view — inside a fan drilldown it's
          noise; “Return to Fan Activity” is the way back. */}
      {!submitted && (
        <FanList
          onSelect={(em) => {
            setUrl({ email: em });
            document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </div>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
  note,
  trailing,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
  note: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{note}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 0}>
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          {page + 1} / {Math.max(1, pageCount)}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPage(page + 1)}
          disabled={page + 1 >= pageCount}
        >
          Next
        </Button>
        {trailing}
      </div>
    </div>
  );
}

function LookupResult({ data }: { data: CustomerLookup }) {
  const { cio, warehouse, sync } = data;

  if (!cio.found && !warehouse.found) {
    return (
      <Alert>
        <AlertTitle>No profile found</AlertTitle>
        <AlertDescription>
          {data.email} has no Customer.io profile and no warehouse fan_attributes row.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      {/* One column until the window is genuinely wide — truncated facts are
          worse than scrolling. */}
      <div className="grid items-start gap-4 2xl:grid-cols-3">
        <IdentityCard data={data} />
        <SyncCard data={data} />
        <SnapshotCard row={warehouse.row} />
      </div>
      {cio.found && cio.cio_id && <ActivityCard cioId={cio.cio_id} />}
      {sync.comparison.length > 0 && (
        <AttributesCard comparison={sync.comparison} syncDueEta={sync.sync_due_eta} />
      )}
      <LedgerCard email={data.email} />
      {(cio.segments?.length ?? 0) > 0 && <SegmentsCard segments={cio.segments!} />}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{children}</span>
    </div>
  );
}

function IdentityCard({ data }: { data: CustomerLookup }) {
  const { cio, warehouse } = data;
  const row = warehouse.row ?? {};
  const attrs = cio.attributes ?? {};
  const name =
    [attrs.first_name, attrs.last_name].filter(Boolean).join(' ') ||
    (row.full_name as string) ||
    'Unknown name';

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{name}</CardTitle>
        <CardDescription className="break-all">{data.email}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant={cio.found ? 'default' : data.sync.first_sync_eta ? 'secondary' : 'outline'}
          >
            {cio.found
              ? 'Customer.io profile'
              : data.sync.first_sync_eta
                ? `Syncing by ~${formatPacific(data.sync.first_sync_eta, false)}`
                : 'Not in Customer.io'}
          </Badge>
          <Badge variant={warehouse.found ? 'default' : 'outline'}>
            {warehouse.found ? 'Warehouse row' : 'Not in warehouse'}
          </Badge>
          {cio.found && (
            <Badge variant={cio.unsubscribed ? 'destructive' : 'secondary'}>
              {cio.unsubscribed ? 'Unsubscribed' : 'Subscribed'}
            </Badge>
          )}
        </div>
        {cio.found && (
          <Fact label="CIO ID">
            <span className="font-mono text-xs">{cio.cio_id}</span>
          </Fact>
        )}
        {typeof row.tm_acct_id === 'string' && row.tm_acct_id && (
          <Fact label="TM account">{row.tm_acct_id}</Fact>
        )}
        {typeof row.sf_account_id === 'string' && row.sf_account_id && (
          <Fact label="SF account">
            <span className="font-mono text-xs">{row.sf_account_id}</span>
          </Fact>
        )}
      </CardContent>
    </Card>
  );
}

function SegmentsCard({ segments }: { segments: { id: number | null; name: string }[] }) {
  /* ?sgq=… so a filtered segment view is shareable like every other filter;
     the page position is transient. */
  const [{ sgq }, setUrl] = useUrlFilters({ sgq: '' });
  const [page, setPage] = useState(0);
  const sorted = [...segments]
    .map((s) => ({ ...s, name: s.name.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const q = sgq.trim().toLowerCase();
  const rows = q
    ? sorted.filter((s) => s.name.toLowerCase().includes(q) || String(s.id ?? '').includes(q))
    : sorted;
  const pageCount = Math.ceil(rows.length / 10);
  const visible = rows.slice(page * 10, page * 10 + 10);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Segments ({segments.length})</CardTitle>
        <CardDescription>
          Every Customer.io segment this fan is currently in. The ID is Customer.io's own segment
          number — the handle to use in campaign triggers and the CIO UI, and what tells apart
          identically-named segments.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search segments by name or ID…"
          value={sgq}
          onChange={(e) => {
            setUrl({ sgq: e.target.value });
            setPage(0);
          }}
        />
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No segments match “{sgq}”.</p>
        )}
        {rows.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">ID</TableHead>
                  <TableHead>Segment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((s) => (
                  <TableRow key={`${s.id}-${s.name}`}>
                    <TableCell className="font-mono text-xs">{s.id ?? '—'}</TableCell>
                    <TableCell className="text-sm break-words">{s.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager
              page={page}
              pageCount={pageCount}
              onPage={setPage}
              note={`${rows.length} segment(s)`}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SyncCard({ data }: { data: CustomerLookup }) {
  const { warehouse, sync, cio } = data;
  const s = sync.summary;
  /* Pendings inside the propagation window ride the next pull — they're
     in-flight, not problems. Without an ETA they're genuinely stuck. */
  const inFlight = cio.found && sync.sync_due_eta ? (s.pending ?? 0) : 0;
  const attention = (s.differs ?? 0) + (s.pending ?? 0) - inFlight;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sync status</CardTitle>
        <CardDescription>Is this fan's data reaching Customer.io correctly?</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-1.5">
          {sync.in_sync_view ? (
            <Badge variant="secondary">In sync view</Badge>
          ) : (
            <Badge variant="outline">Not in sync view</Badge>
          )}
          {sync.comparison.length > 0 &&
            (sync.first_sync_eta && !cio.found ? (
              <Badge variant="secondary">
                First sync by ~{formatPacific(sync.first_sync_eta, false)}
              </Badge>
            ) : attention > 0 ? (
              <Badge variant="destructive">{attention} need attention</Badge>
            ) : inFlight > 0 ? (
              <Badge variant="secondary">
                {inFlight} syncing by ~{formatPacific(sync.sync_due_eta!, false)}
              </Badge>
            ) : (
              <Badge variant="default">Attributes in sync</Badge>
            ))}
        </div>
        {sync.first_sync_eta && !cio.found && (
          <p className="text-sm text-muted-foreground">
            This fan's row is newer than the connector's last hourly pull — Customer.io creates the
            profile and writes every pending attribute on the next one.
          </p>
        )}
        {sync.excluded_reason && (
          <p className="text-sm text-muted-foreground">{sync.excluded_reason}</p>
        )}
        {!warehouse.found && (
          <p className="text-sm text-muted-foreground">
            Not in the warehouse yet — fans created directly in Customer.io (imports, test
            identities, signup webhooks) are picked up by the next hourly refresh.
          </p>
        )}
        {warehouse.updated_at && (
          <Fact label="Row last changed">
            {formatPacific(warehouse.updated_at)}{' '}
            <span className="text-muted-foreground">({relativeFrom(warehouse.updated_at)})</span>
          </Fact>
        )}
        {warehouse.table_built_at && (
          <Fact label="Warehouse built">
            {formatPacific(warehouse.table_built_at)}{' '}
            <span className="text-muted-foreground">
              ({relativeFrom(warehouse.table_built_at)})
            </span>
          </Fact>
        )}
        {cio.last_attribute_write && (
          <Fact label="Last CIO write">
            {formatPacific(cio.last_attribute_write)}{' '}
            <span className="text-muted-foreground">
              ({relativeFrom(cio.last_attribute_write)})
            </span>
          </Fact>
        )}
        {sync.comparison.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {s.match ?? 0} match · {s.differs ?? 0} differ · {s.pending ?? 0} pending ·{' '}
            {s.cio_only ?? 0} CIO-only · {s.empty ?? 0} empty
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SnapshotCard({ row }: { row: Record<string, unknown> | null }) {
  if (!row) {
    return (
      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Fan snapshot</CardTitle>
          <CardDescription>No warehouse attributes for this person yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const money = (v: unknown) =>
    typeof v === 'number' ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null;
  const facts: Array<[string, ReactNode]> = [
    [
      'Sprocket segment',
      [row.sprocket_macro, row.sprocket_sub_segment].filter(Boolean).join(' · ') || null,
    ],
    ['STM', (row.stm_product as string) || (row.stm_type as string) || null],
    ['Member status', (row.ticketing_member_status as string) || null],
    [
      'Matches attended',
      row.matches_attended_lifetime != null
        ? `${row.matches_attended_lifetime} lifetime · ${row.matches_attended_2026 ?? 0} in 2026`
        : null,
    ],
    [
      'Last attended',
      row.last_attendance_date ? formatPacific(String(row.last_attendance_date)) : null,
    ],
    ['Ticket spend', money(row.ticket_lifetime_spend)],
    ['Merch spend', money(row.shopify_amount_spent)],
    ['Lifetime spend', money(row.lifetime_spend)],
    [
      'Next event',
      row.ticketing_event_name
        ? `${row.ticketing_event_name}${row.ticketing_event_date ? ` (${formatPacific(String(row.ticketing_event_date))})` : ''}`
        : null,
    ],
    ['Signup campaign', (row.tb_signup_campaign as string) || null],
  ];
  const present = facts.filter(([, v]) => v != null);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fan snapshot</CardTitle>
        <CardDescription>
          Who this fan is to the club — tickets, attendance and spend.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {present.length === 0 && (
          <p className="text-sm text-muted-foreground">No notable attributes populated.</p>
        )}
        {present.map(([label, value]) => (
          <Fact key={label} label={label}>
            {value}
          </Fact>
        ))}
      </CardContent>
    </Card>
  );
}

// ---- Attribute comparison table ----

const attrStatusMeta: Record<
  AttrStatus,
  { label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }
> = {
  match: { label: 'Match', variant: 'secondary' },
  differs: { label: 'Differs', variant: 'destructive' },
  pending: { label: 'Pending sync', variant: 'default' },
  cio_only: { label: 'CIO only', variant: 'outline' },
  empty: { label: 'Empty', variant: 'outline' },
};

/* CIO-only attributes are deliberately NOT "needs attention": they're names
   the sync never sends (legacy imports, campaign-written values) — unmanaged,
   not broken. They get their own tab so orphans stay auditable without
   alarming anyone (Kevin's primary_ticketing_account question, Jul 31). */
const ATTR_TABS = [
  { key: 'attention', label: 'Needs attention', statuses: ['differs', 'pending'] },
  { key: 'match', label: 'Match', statuses: ['match'] },
  { key: 'cio_only', label: 'CIO only', statuses: ['cio_only'] },
  { key: 'all', label: 'All', statuses: ['match', 'differs', 'pending', 'cio_only', 'empty'] },
] as const;

function attrValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const attrCol = createColumnHelper<AttrComparison>();

function AttributesCard({
  comparison,
  syncDueEta,
}: {
  comparison: AttrComparison[];
  syncDueEta?: string | null;
}) {
  const hasAttention = comparison.some((c) => ['differs', 'pending'].includes(c.status));
  /* Empty means "pick for me" — a profile with nothing to review opens on All.
     An explicit ?atab= from a shared link always wins over that default. */
  const [{ atab }, setUrl] = useUrlFilters({ atab: '' }, ['atab']);
  const tab = atab
    ? oneOf(
        atab,
        ATTR_TABS.map((t) => t.key),
        'all'
      )
    : hasAttention
      ? 'attention'
      : 'all';
  const setTab = (v: string) => setUrl({ atab: v });
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const allowed = ATTR_TABS.find((t) => t.key === tab)?.statuses ?? [];
    return comparison.filter((c) => (allowed as readonly string[]).includes(c.status));
  }, [comparison, tab]);

  const columns = useMemo(
    () => [
      attrCol.accessor('name', {
        header: 'Attribute',
        cell: (c) => (
          <div>
            <div className="font-medium">{humanizeAttr(c.getValue())}</div>
            <div className="font-mono text-xs text-muted-foreground">{c.getValue()}</div>
          </div>
        ),
      }),
      attrCol.accessor('warehouse', {
        header: 'Warehouse',
        cell: (c) => (
          <span className="block max-w-56 truncate" title={attrValue(c.getValue())}>
            {attrValue(c.getValue())}
          </span>
        ),
      }),
      attrCol.accessor('cio', {
        header: 'Customer.io',
        cell: (c) => (
          <span className="block max-w-56 truncate" title={attrValue(c.getValue())}>
            {attrValue(c.getValue())}
          </span>
        ),
      }),
      attrCol.accessor('status', {
        header: 'Status',
        cell: (c) => {
          // In-flight rows say when the pull that carries them lands.
          if (c.getValue() === 'pending' && syncDueEta)
            return (
              <Badge variant="secondary" className="whitespace-nowrap">
                Sync due ~{formatPacific(syncDueEta, false)}
              </Badge>
            );
          const meta = attrStatusMeta[c.getValue()];
          return <Badge variant={meta.variant}>{meta.label}</Badge>;
        },
      }),
      attrCol.accessor('cio_updated_at', {
        header: 'CIO updated',
        cell: (c) => {
          const v = c.getValue();
          return v ? (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {relativeFrom(v)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      }),
    ],
    [syncDueEta]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { globalFilter: search },
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row, _col, value) => {
      const q = String(value).toLowerCase();
      const r = row.original;
      return (
        r.name.toLowerCase().includes(q) ||
        humanizeAttr(r.name).toLowerCase().includes(q) ||
        attrValue(r.warehouse).toLowerCase().includes(q) ||
        attrValue(r.cio).toLowerCase().includes(q)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 10 } },
  });

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const c of comparison) by[c.status] = (by[c.status] ?? 0) + 1;
    return {
      attention: (by.differs ?? 0) + (by.pending ?? 0),
      match: by.match ?? 0,
      cio_only: by.cio_only ?? 0,
      all: comparison.length,
    } as Record<string, number>;
  }, [comparison]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Attributes</CardTitle>
        <CardDescription>
          What we send to Customer.io vs what their profile actually shows — differences here mean
          campaigns could target this fan with wrong or stale data.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {ATTR_TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label} ({counts[t.key] ?? 0})
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Input
            className="max-w-56"
            placeholder="Filter attributes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === 'cio_only' && (
          <p className="text-sm text-muted-foreground">
            Attributes on the Customer.io profile that the warehouse sync doesn't send — legacy
            imports or campaign-written values. They never update, which is only a problem if a
            journey still references one.
          </p>
        )}
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => (
                    <TableHead key={h.id}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-16 text-center text-muted-foreground"
                  >
                    Nothing in this view.
                  </TableCell>
                </TableRow>
              )}
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {table.getFilteredRowModel().rows.length} attribute(s)
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Activity timeline + delivery ledger ----

const activityLabel: Record<string, string> = {
  event: 'Event',
  attribute_update: 'Attributes updated',
  sent_email: 'Email sent',
  delivered_email: 'Email delivered',
  opened_email: 'Email opened',
  clicked_email: 'Email clicked',
  failed_email: 'Email failed',
  bounced_email: 'Email bounced',
  spammed_email: 'Marked as spam',
  unsubscribed: 'Unsubscribed',
  subscribed: 'Subscribed',
  triggered_campaign: 'Campaign triggered',
  entered_segment: 'Entered segment',
  left_segment: 'Left segment',
  sent_webhook: 'Webhook sent',
};

const activityDot: Record<string, string> = {
  opened_email: 'bg-emerald-500',
  clicked_email: 'bg-emerald-500',
  delivered_email: 'bg-sky-500',
  sent_email: 'bg-sky-400',
  failed_email: 'bg-red-500',
  bounced_email: 'bg-red-500',
  spammed_email: 'bg-red-500',
  unsubscribed: 'bg-red-500',
  event: 'bg-violet-500',
  attribute_update: 'bg-amber-500',
};

/* The sync's own watermark rides along as a person attribute (the connector
   must select updated_at_unix to drive incremental pulls), so a source
   re-ingest that changes nothing human-visible still logs an attribute_change
   whose entire diff is the watermark. Those are sync heartbeats, not fan
   history — hidden from the timeline. */
const SYNC_PLUMBING_ATTRS = new Set(['updated_at_unix']);

function attributeDiffs(a: CioActivity): Array<{ attr: string; from: string; to: string }> {
  if (a.type !== 'attribute_change') return [];
  return Object.entries(a.data ?? {})
    .filter(([k]) => !SYNC_PLUMBING_ATTRS.has(k) && !k.startsWith('_'))
    .map(([k, v]) => {
      const d = (v ?? {}) as Record<string, unknown>;
      return { attr: k, from: String(d.from ?? ''), to: String(d.to ?? '') };
    });
}

const isSyncHeartbeat = (a: CioActivity) =>
  a.type === 'attribute_change' && attributeDiffs(a).length === 0;

function activityDetail(a: CioActivity): string {
  if (a.name) return String(a.name);
  const d = a.data ?? {};
  if (a.type === 'attribute_change') {
    const diffs = attributeDiffs(a);
    const shown = diffs.slice(0, 2).map((x) => `${x.attr}: ${x.from || '—'} → ${x.to || '—'}`);
    return shown.join(' · ') + (diffs.length > 2 ? ` · +${diffs.length - 2} more` : '');
  }
  if (a.type === 'attribute_update')
    return Object.keys(d)
      .filter((k) => !k.startsWith('_'))
      .slice(0, 6)
      .join(', ');
  if (typeof d.subject === 'string') return d.subject;
  if (d.template_id != null) return `Template ${d.template_id}`;
  return '';
}

function messageStatus(m: CioMessage): {
  label: string;
  variant: 'default' | 'destructive' | 'secondary' | 'outline';
} {
  const mt = m.metrics ?? {};
  if (m.failure_message) return { label: 'Failed', variant: 'destructive' };
  if (mt.bounced) return { label: 'Bounced', variant: 'destructive' };
  if (mt.clicked) return { label: 'Clicked', variant: 'default' };
  if (mt.opened) return { label: 'Opened', variant: 'default' };
  if (mt.delivered) return { label: 'Delivered', variant: 'secondary' };
  if (mt.sent) return { label: 'Sent', variant: 'secondary' };
  return { label: 'Created', variant: 'outline' };
}

function messageKind(m: CioMessage): string {
  if (m.newsletter_id != null) return 'Newsletter';
  if (m.campaign_id != null) return 'Campaign';
  if (m.transactional_message_id != null) return 'Transactional';
  return m.type;
}

const ACTIVITY_TABS = ['timeline', 'messages'] as const;

function ActivityCard({ cioId }: { cioId: string }) {
  const [{ ptab, aq }, setUrl] = useUrlFilters({ ptab: 'timeline', aq: '' }, ['ptab']);
  const tab = oneOf(ptab, ACTIVITY_TABS, 'timeline');
  const [page, setPage] = useState(0);
  const setTab = (v: string) => {
    setUrl({ ptab: v });
    setPage(0);
  };

  /* CIO pages by cursor (forward-only), so fetch big chunks and page the
     display locally by 10 — that also gives the filter something to bite on. */
  const activities = useInfiniteQuery<ActivitiesPage>({
    queryKey: ['customer-activities', cioId],
    queryFn: ({ pageParam }) =>
      api.get(
        `/api/customers/${cioId}/activities?limit=50${pageParam ? `&start=${encodeURIComponent(String(pageParam))}` : ''}`
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === 'timeline',
  });

  const messages = useInfiniteQuery<MessagesPage>({
    queryKey: ['customer-messages', cioId],
    queryFn: ({ pageParam }) =>
      api.get(
        `/api/customers/${cioId}/messages?limit=50${pageParam ? `&start=${encodeURIComponent(String(pageParam))}` : ''}`
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === 'messages',
  });

  const q = aq.trim().toLowerCase();
  const allActivities = (activities.data?.pages.flatMap((p) => p.activities) ?? []).filter(
    (a) => !isSyncHeartbeat(a)
  );
  const allMessages = messages.data?.pages.flatMap((p) => p.messages) ?? [];
  const activityRows = q
    ? allActivities.filter((a) =>
        [activityLabel[a.type] ?? a.type, activityDetail(a), a.name ?? '']
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
    : allActivities;
  const messageRows = q
    ? allMessages.filter((m) =>
        [m.subject ?? '', messageKind(m), messageStatus(m).label, m.failure_message ?? '']
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
    : allMessages;
  const active = tab === 'timeline' ? activities : messages;
  const filtered = tab === 'timeline' ? activityRows.length : messageRows.length;
  const loaded = tab === 'timeline' ? allActivities.length : allMessages.length;
  const pageCount = Math.ceil(filtered / 10);
  const pagedActivities = activityRows.slice(page * 10, page * 10 + 10);
  const pagedMessages = messageRows.slice(page * 10, page * 10 + 10);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Activity</CardTitle>
        <CardDescription>
          What Customer.io has done with this fan — messages, opens, clicks — live, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'timeline' | 'messages')}>
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            className="max-w-56"
            placeholder={tab === 'timeline' ? 'Filter activity…' : 'Filter messages…'}
            value={aq}
            onChange={(e) => {
              setUrl({ aq: e.target.value });
              setPage(0);
            }}
          />
        </div>

        {active.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(active.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {active.isPending && <Skeleton className="h-32" />}

        {tab === 'timeline' && !activities.isPending && (
          <div className="grid">
            {activityRows.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                {q ? `Nothing loaded matches “${aq}”.` : 'No activity recorded.'}
              </p>
            )}
            {pagedActivities.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 border-b py-2.5 text-sm last:border-b-0"
              >
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    activityDot[a.type] ?? 'bg-muted-foreground/40'
                  )}
                />
                <span className="w-40 shrink-0 font-medium">
                  {activityLabel[a.type] ?? a.type.replace(/_/g, ' ')}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {activityDetail(a)}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                  {formatUnix(a.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === 'messages' && !messages.isPending && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {messageRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                      {q ? `Nothing loaded matches “${aq}”.` : 'No messages sent to this person.'}
                    </TableCell>
                  </TableRow>
                )}
                {pagedMessages.map((m) => {
                  const st = messageStatus(m);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="max-w-80">
                        <span className="block truncate font-medium" title={m.subject ?? ''}>
                          {m.subject || '(no subject)'}
                        </span>
                        {m.failure_message && (
                          <span className="block truncate text-xs text-destructive">
                            {m.failure_message}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{messageKind(m)}</TableCell>
                      <TableCell>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {formatUnix(m.metrics?.sent ?? m.created)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {!active.isPending && (filtered > 0 || active.hasNextPage) && (
          <Pager
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            note={
              q
                ? `${filtered} of ${loaded} loaded match`
                : `${loaded} loaded${active.hasNextPage ? ' · more in Customer.io' : ''}`
            }
            trailing={
              active.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void active.fetchNextPage()}
                  disabled={active.isFetchingNextPage}
                >
                  {active.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : undefined
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---- Latest active fans (server-paged browse list) ----

const FAN_PAGE = 20;

function FanList({ onSelect }: { onSelect: (email: string) => void }) {
  const [{ q, offset }, setUrl] = useUrlFilters({ q: '', offset: 0 });
  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);

  const list = useQuery<FanListPage>({
    queryKey: ['fan-list', q, offset],
    queryFn: () =>
      api.get(
        `/api/customers/list?limit=${FAN_PAGE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setUrl({ q: qInput.trim(), offset: 0 });
  }

  const money = (v: number | null) =>
    v != null ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
  const data = list.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Latest active fans</CardTitle>
            <CardDescription>
              Subscribed fans whose data changed most recently — new signups, purchases, attendance.
              Click a row for the full profile.
            </CardDescription>
          </div>
          <form onSubmit={onSearch} className="flex items-center gap-2">
            <Input
              className="w-64"
              placeholder="Search email, name, TM account, zip…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={list.isFetching}>
              Search
            </Button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {list.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {list.isPending && <Skeleton className="h-64" />}
        {data && (
          <>
            <div
              className={cn('overflow-x-auto rounded-md border', list.isFetching && 'opacity-60')}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fan</TableHead>
                    <TableHead>Segment</TableHead>
                    <TableHead>STM</TableHead>
                    <TableHead className="text-right">2026 matches</TableHead>
                    <TableHead>Last attended</TableHead>
                    <TableHead className="text-right">Ticket spend</TableHead>
                    <TableHead className="text-right">Merch spend</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.fans.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="h-16 text-center text-muted-foreground">
                        No fans match{q ? ` “${q}”` : ''}.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.fans.map((f) => (
                    <TableRow
                      key={f.email}
                      className="cursor-pointer"
                      onClick={() => onSelect(f.email)}
                    >
                      <TableCell>
                        <div className="font-medium">{f.full_name || '—'}</div>
                        <div className="text-xs text-muted-foreground">{f.email}</div>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {f.sprocket_macro ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-44 truncate text-sm text-muted-foreground">
                        {f.stm_product ?? f.stm_type ?? f.ticketing_member_status ?? '—'}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {f.matches_attended_2026 ?? 0}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {f.last_attendance_date ? formatPacific(f.last_attendance_date) : '—'}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {money(f.ticket_lifetime_spend ?? 0)}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {money(f.shopify_amount_spent ?? 0)}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {relativeFrom(f.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {data.total === 0
                  ? '0 fans'
                  : `${data.offset + 1}–${data.offset + data.fans.length} of ${data.total.toLocaleString()} fans`}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || list.isFetching}
                  onClick={() => setUrl({ offset: Math.max(0, offset - FAN_PAGE) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + FAN_PAGE >= data.total || list.isFetching}
                  onClick={() => setUrl({ offset: offset + FAN_PAGE })}
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

// ---- Warehouse activity ledger (customer_events + customer_status_ledger) ----

const ledgerSourceDot: Record<string, string> = {
  customerio: 'bg-sky-500',
  tradablebits: 'bg-violet-500',
};

function ledgerStatusVariant(s: LedgerStatus): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (/unsub|dropped|lapsed|inactive/i.test(s.status)) return 'destructive';
  return 'secondary';
}

const ledgerEventDetail = (e: LedgerEvent) => eventDetailLine(e.activity, e.feature_json);

function LedgerCard({ email }: { email: string }) {
  /* ?lq=… holds the SUBMITTED ledger search so a filtered view is shareable;
     the input below is a draft until Search/Enter. */
  const [{ lq }, setUrl] = useUrlFilters({ lq: '' });
  const [draft, setDraft] = useState(lq);
  useEffect(() => setDraft(lq), [lq]);

  const [offset, setOffset] = useState(0);
  const ledger = useQuery<FanLedgerPage>({
    queryKey: ['fan-ledger', email, lq, offset],
    queryFn: () =>
      api.get(
        `/api/customers/ledger?email=${encodeURIComponent(email)}&limit=10&offset=${offset}` +
          (lq ? `&q=${encodeURIComponent(lq)}` : '')
      ),
    placeholderData: (prev) => prev,
  });

  const statuses = ledger.data?.statuses ?? [];
  const events = ledger.data?.events ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Activity ledger</CardTitle>
        <CardDescription>
          The audited source of truth for this fan — their history across every system, live to
          within about five minutes. The status chips refresh daily.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setUrl({ lq: draft.trim() });
            setOffset(0);
          }}
        >
          <Input
            className="max-w-xs"
            placeholder="Search activities, sources, details…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {lq && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setUrl({ lq: '' });
                setOffset(0);
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {ledger.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(ledger.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {ledger.isPending && <Skeleton className="h-32" />}

        {statuses.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {statuses.map((s) => (
              <div
                key={s.status_domain}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                title={`authority: ${s.authority ?? '—'}${s.status_since ? ` · since ${formatPacific(s.status_since)}` : ''}`}
              >
                <span className="text-muted-foreground">{humanizeAttr(s.status_domain)}</span>
                <Badge variant={ledgerStatusVariant(s)}>{s.status}</Badge>
                {s.latched && <Badge variant="outline">latched</Badge>}
              </div>
            ))}
          </div>
        )}

        {!ledger.isPending && (
          <div className="grid">
            {events.length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">
                {lq ? `No ledger events match “${lq}”.` : 'No ledger events for this fan.'}
              </p>
            )}
            {events.map((e) => (
              <div
                key={e.event_id}
                className={cn(
                  'flex items-center gap-3 border-b py-2.5 text-sm last:border-b-0',
                  e.is_system_echo && 'opacity-60'
                )}
              >
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    ledgerSourceDot[e.source_system ?? ''] ?? 'bg-muted-foreground/40'
                  )}
                />
                <span className="w-44 shrink-0 font-medium">
                  {humanizeAttr(e.activity)}
                  {e.is_system_echo && (
                    <span className="ml-1 text-xs text-muted-foreground">(echo)</span>
                  )}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-muted-foreground"
                  title={ledgerEventDetail(e)}
                >
                  {ledgerEventDetail(e)}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                  {e.source_system ?? ''} · {formatPacific(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}

        {!ledger.isPending && (events.length > 0 || offset > 0) && (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - 10))}
              disabled={offset === 0 || ledger.isFetching}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {offset / 10 + 1}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + 10)}
              disabled={!ledger.data?.has_more || ledger.isFetching}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
