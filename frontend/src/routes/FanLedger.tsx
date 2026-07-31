import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { oneOf, useUrlFilters } from '@/lib/urlState';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type LedgerEventRow,
  type LedgerEventsPage,
  type LedgerStatusesPage,
} from '@/lib/api';
import { formatPacific, humanizeAttr, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UnderlineTabs } from '@/components/ui/underline-tabs';
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
const WINDOWS = ['24h', '7d', '30d', 'all'] as const;

const selectCls =
  'border-input bg-background h-9 max-w-[400px] rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function FacetSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel: string;
}) {
  return (
    <select
      className={selectCls}
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {humanizeAttr(o)}
        </option>
      ))}
    </select>
  );
}

function Pager({
  total,
  offset,
  count,
  busy,
  onOffset,
}: {
  total: number;
  offset: number;
  count: number;
  busy: boolean;
  onOffset: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">
        {total === 0 ? '0 rows' : `${offset + 1}–${offset + count} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0 || busy}
          onClick={() => onOffset(Math.max(0, offset - PAGE))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + PAGE >= total || busy}
          onClick={() => onOffset(offset + PAGE)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/* Activities whose from_value/to_value are a flip of one named CIO attribute.
   The polarity is the INVERSE of the activity name — "Resubscribed email"
   means `unsubscribed` went true → false — so naming the attribute in the
   detail is what makes the row readable. */
const FLAG_ATTRIBUTE: Record<string, string> = {
  unsubscribed_email: 'Unsubscribed',
  resubscribed_email: 'Unsubscribed',
};

const present = (v: unknown) => v !== null && v !== '' && v !== undefined;

function flagValue(v: unknown): string {
  const s = String(v).toLowerCase();
  if (s === 'true') return 'True';
  if (s === 'false') return 'False';
  return String(v);
}

function eventDetail(e: LedgerEventRow): string {
  if (!e.feature_json) return '';
  try {
    const obj = JSON.parse(e.feature_json) as Record<string, unknown>;
    const attr = FLAG_ATTRIBUTE[e.activity];
    if (attr && present(obj.to_value)) {
      const to = `${attr}=${flagValue(obj.to_value)}`;
      // A missing `from` means the attribute was set for the first time rather
      // than flipped, so there is no prior state to show.
      return present(obj.from_value) ? `${attr}=${flagValue(obj.from_value)} → ${to}` : to;
    }
    // cio_id identifies the profile, which the Fan column already names.
    return Object.entries(obj)
      .filter(([k, v]) => k !== 'cio_id' && present(v))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ');
  } catch {
    return e.feature_json;
  }
}

const TABS = ['events', 'statuses'] as const;

export default function FanLedger() {
  const [{ tab: rawTab }, setUrl] = useUrlFilters({ tab: 'events', offset: 0 });
  const tab = oneOf(rawTab, TABS, 'events');
  // Paging is shared between the tabs, so switching returns to page 1 rather
  // than landing on an offset the other tab may not have.
  const setTab = (v: string) => setUrl({ tab: v, offset: 0 });
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Fan Ledger</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The audited record behind every fan-facing decision — what happened across all our
            systems (Events) and where each fan stands today (Statuses). Click any row to open the
            fan's full profile.
          </p>
        </div>
      </div>
      <UnderlineTabs
        tabs={
          [
            { key: 'events', label: 'Events' },
            { key: 'statuses', label: 'Statuses' },
          ] as const
        }
        value={tab}
        onChange={setTab}
      />
      {tab === 'events' ? <EventsTab /> : <StatusesTab />}
    </div>
  );
}

function EventsTab() {
  const navigate = useNavigate();
  const [url, setUrl] = useUrlFilters({
    q: '',
    window: '7d',
    activity: '',
    source: '',
    echo: false,
    offset: 0,
  });
  const { q, activity, source, echo: includeEcho, offset } = url;
  const window = oneOf(url.window, WINDOWS, '7d');

  // The box holds a draft until submit; only the submitted term reaches the URL.
  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);

  const query = useQuery<LedgerEventsPage>({
    queryKey: ['ledger-events', q, window, activity, source, includeEcho, offset],
    queryFn: () => {
      const p = new URLSearchParams({ window, limit: String(PAGE), offset: String(offset) });
      if (q) p.set('q', q);
      if (activity) p.set('activity', activity);
      if (source) p.set('source', source);
      if (includeEcho) p.set('include_echo', 'true');
      return api.get(`/api/ledger/events?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setUrl({ q: qInput.trim(), offset: 0 });
  }

  const data = query.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={onSearch} className="flex items-center gap-2">
            <Input
              className="w-60"
              placeholder="Search fan email or activity…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={query.isFetching}>
              Search
            </Button>
          </form>
          <Tabs value={window} onValueChange={(v) => setUrl({ window: v, offset: 0 })}>
            <TabsList>
              {WINDOWS.map((w) => (
                <TabsTrigger key={w} value={w}>
                  {w === 'all' ? 'All time' : `Last ${w}`}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FacetSelect
            value={activity}
            onChange={(v) => setUrl({ activity: v, offset: 0 })}
            options={data?.activities ?? []}
            allLabel="All activities"
          />
          <FacetSelect
            value={source}
            onChange={(v) => setUrl({ source: v, offset: 0 })}
            options={data?.sources ?? []}
            allLabel="All sources"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeEcho}
              onChange={(e) => setUrl({ echo: e.target.checked, offset: 0 })}
            />
            Include system echoes
          </label>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {query.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(query.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {query.isPending && <Skeleton className="h-72" />}
        {data && (
          <>
            <div
              className={cn('overflow-x-auto rounded-md border', query.isFetching && 'opacity-60')}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Fan</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.events.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                        No events match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.events.map((e) => (
                    <TableRow
                      key={e.event_id}
                      className={cn('cursor-pointer', e.is_system_echo && 'opacity-60')}
                      onClick={() => navigate(`/fans?email=${encodeURIComponent(e.customer)}`)}
                    >
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        <div>{formatPacific(e.ts)}</div>
                        <div>{relativeFrom(e.ts)}</div>
                      </TableCell>
                      <TableCell className="max-w-56">
                        <span className="block truncate text-sm" title={e.customer}>
                          {e.customer}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm font-medium whitespace-nowrap">
                        {humanizeAttr(e.activity)}
                        {e.is_system_echo && (
                          <span className="ml-1 text-xs text-muted-foreground">(echo)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {e.source_system ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-96 text-muted-foreground">
                        <span className="block truncate text-xs" title={eventDetail(e)}>
                          {eventDetail(e)}
                          {e.revenue_impact != null && ` · $${e.revenue_impact}`}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager
              total={data.total}
              offset={data.offset}
              count={data.events.length}
              busy={query.isFetching}
              onOffset={(n) => setUrl({ offset: n })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusesTab() {
  const navigate = useNavigate();
  // `q` is shared with the events tab on purpose — looking up a fan and then
  // flipping between what happened and where they stand keeps the search.
  const [url, setUrl] = useUrlFilters({
    q: '',
    domain: '',
    status: '',
    latched: false,
    offset: 0,
  });
  const { q, domain, status, latched: latchedOnly, offset } = url;

  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);

  const query = useQuery<LedgerStatusesPage>({
    queryKey: ['ledger-statuses', q, domain, status, latchedOnly, offset],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (q) p.set('q', q);
      if (domain) p.set('domain', domain);
      if (status) p.set('status', status);
      if (latchedOnly) p.set('latched_only', 'true');
      return api.get(`/api/ledger/statuses?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setUrl({ q: qInput.trim(), offset: 0 });
  }

  const data = query.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={onSearch} className="flex items-center gap-2">
            <Input
              className="w-60"
              placeholder="Search fan email…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={query.isFetching}>
              Search
            </Button>
          </form>
          <FacetSelect
            value={domain}
            onChange={(v) => setUrl({ domain: v, offset: 0 })}
            options={data?.domains ?? []}
            allLabel="All domains"
          />
          <FacetSelect
            value={status}
            onChange={(v) => setUrl({ status: v, offset: 0 })}
            options={data?.status_values ?? []}
            allLabel="All statuses"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={latchedOnly}
              onChange={(e) => setUrl({ latched: e.target.checked, offset: 0 })}
            />
            Latched only
          </label>
        </div>
        <CardDescription className="mt-2">
          Each fan's current standing, one row per area (email subscription today; tickets and
          engagement to follow). “Latched” marks protected statuses — like opt-outs — that no
          automated sync is allowed to overwrite.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {query.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(query.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {query.isPending && <Skeleton className="h-72" />}
        {data && (
          <>
            <div
              className={cn('overflow-x-auto rounded-md border', query.isFetching && 'opacity-60')}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fan</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Authority</TableHead>
                    <TableHead>Since</TableHead>
                    <TableHead>Last event</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.statuses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-16 text-center text-muted-foreground">
                        No rows match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.statuses.map((s) => (
                    <TableRow
                      key={`${s.email}-${s.status_domain}`}
                      className="cursor-pointer"
                      onClick={() => navigate(`/fans?email=${encodeURIComponent(s.email)}`)}
                    >
                      <TableCell className="max-w-64">
                        <span className="block truncate text-sm" title={s.email}>
                          {s.email}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {humanizeAttr(s.status_domain)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={
                              /unsub|dropped|lapsed|inactive/i.test(s.status)
                                ? 'destructive'
                                : 'secondary'
                            }
                          >
                            {s.status}
                          </Badge>
                          {s.latched && <Badge variant="outline">latched</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {s.authority ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {s.status_since ? formatPacific(s.status_since) : '—'}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {s.last_event_at ? relativeFrom(s.last_event_at) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager
              total={data.total}
              offset={data.offset}
              count={data.statuses.length}
              busy={query.isFetching}
              onOffset={(n) => setUrl({ offset: n })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
