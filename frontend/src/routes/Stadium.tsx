import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type StadiumEventRow,
  type StadiumEventsResponse,
  type StadiumHeatResponse,
  type StadiumSectionHeat,
} from '@/lib/api';
import StadiumHeatmap, {
  type HoverInfo,
  BUCKETS_DARK,
  BUCKETS_LIGHT,
  NO_DATA_DARK,
  NO_DATA_LIGHT,
} from '@/components/StadiumHeatmap';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type Metric = 'pct_sold' | 'occupied' | 'sold' | 'comps' | 'scans';

// "occupied" = seats with status SOLD or COMP in the latest snapshot — the
// expected occupancy (paid + comps), not attendance. "scans" = distinct seats
// with an accepted entry scan (valid=Y, result A) — only past events have them.
const METRIC_LABEL: Record<Metric, string> = {
  pct_sold: '% Sold',
  occupied: 'Sold + Comps',
  sold: 'Sold',
  comps: 'Comps',
  scans: 'Scans',
};

function fmtDate(d: string | null): string {
  if (!d) return '';
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function num(v: number | null | undefined): string {
  return v == null ? '—' : v.toLocaleString('en-US');
}

function comps(r: { occupied: number | null; sold: number | null }): number | null {
  return r.occupied != null && r.sold != null ? r.occupied - r.sold : null;
}

function rawValue(r: StadiumSectionHeat, metric: Metric): number | null {
  switch (metric) {
    case 'sold':
      return r.sold;
    case 'occupied':
      return r.occupied;
    case 'comps':
      return comps(r);
    case 'scans':
      return r.scanned;
    default:
      return null;
  }
}

interface EventGroups {
  upcoming: StadiumEventRow[];
  past: StadiumEventRow[];
  undated: StadiumEventRow[];
}

type EventWhen = 'future' | 'past' | 'all';
const EVENT_WHEN: { key: EventWhen; label: string }[] = [
  { key: 'future', label: 'Future' },
  { key: 'past', label: 'Past' },
  { key: 'all', label: 'All' },
];

/* Gradient stat tiles in the talent-platform dashboard style (StatCard). */
const TILE_GRADIENTS = {
  azul: 'from-sdfc-azul-dark to-sdfc-azul',
  chrome: 'from-sdfc-chrome-dark to-sdfc-chrome',
  green: 'from-sdfc-green-dark to-sdfc-green',
  orange: 'from-sdfc-orange-dark to-sdfc-orange',
} as const;

function StatTile({
  title,
  value,
  description,
  gradient,
}: {
  title: string;
  value: string;
  description: string;
  gradient: keyof typeof TILE_GRADIENTS;
}) {
  return (
    <div
      className={cn(
        'rounded-xl bg-gradient-to-br p-6 text-white shadow-lg',
        TILE_GRADIENTS[gradient]
      )}
    >
      <div className="text-sm font-medium tracking-wide text-white/90 uppercase">{title}</div>
      <div className="mt-2 text-4xl font-bold">{value}</div>
      <div className="mt-4 text-sm text-white/90">{description}</div>
    </div>
  );
}

export default function Stadium() {
  const [selected, setSelected] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('pct_sold');
  const [normalize, setNormalize] = useState(true);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [when, setWhen] = useState<EventWhen>('future');
  const searchRef = useRef<HTMLInputElement>(null);

  const events = useQuery<StadiumEventsResponse>({
    queryKey: ['stadium-events'],
    queryFn: () => api.get('/api/stadium-heat/events'),
    staleTime: 5 * 60_000,
  });

  const eventName = selected ?? events.data?.next_event ?? null;
  const heat = useQuery<StadiumHeatResponse>({
    queryKey: ['stadium-heat', eventName],
    queryFn: () => api.get(`/api/stadium-heat?event=${encodeURIComponent(eventName!)}`),
    enabled: !!eventName,
    staleTime: 5 * 60_000,
  });

  /* Text matches the 6SD code and the date in both ISO and pretty forms; the
     date window keeps only events inside [from, to] (undated events drop out
     whenever a window is set). */
  const grouped: EventGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (events.data?.events ?? []).filter((r) => {
      const textHit =
        !q ||
        r.event_name.toLowerCase().includes(q) ||
        (r.event_date ?? '').includes(q) ||
        fmtDate(r.event_date).toLowerCase().includes(q);
      if (!textHit) return false;
      if ((dateFrom || dateTo) && !r.event_date) return false;
      if (dateFrom && r.event_date! < dateFrom) return false;
      if (dateTo && r.event_date! > dateTo) return false;
      return true;
    });
    const today = new Date().toISOString().slice(0, 10);
    // Undated events are neither future nor past, so they surface only under All.
    return {
      upcoming:
        when === 'past'
          ? []
          : rows
              .filter((r) => r.event_date && r.event_date >= today)
              .sort((a, b) => a.event_date!.localeCompare(b.event_date!)),
      past:
        when === 'future'
          ? []
          : rows
              .filter((r) => r.event_date && r.event_date < today)
              .sort((a, b) => b.event_date!.localeCompare(a.event_date!)),
      undated: when === 'all' ? rows.filter((r) => !r.event_date) : [],
    };
  }, [events.data, search, dateFrom, dateTo, when]);

  const eventRow = events.data?.events.find((e) => e.event_name === eventName);

  /* Normalized 0..1 value per section for the stepped ramp. Scans normalize
     against tickets out (sold + comps) — the show-up rate; the count metrics
     against section capacity. */
  const values = useMemo(() => {
    const out: Record<string, number | null> = {};
    const rows = heat.data?.sections ?? [];
    if (metric === 'pct_sold') {
      for (const r of rows) out[r.section] = r.pct_sold;
      return out;
    }
    if (normalize) {
      for (const r of rows) {
        const v = rawValue(r, metric);
        const denom = metric === 'scans' ? r.occupied : r.total_seats;
        out[r.section] = v == null || !denom ? null : Math.min(1, v / denom);
      }
      return out;
    }
    const max = Math.max(1, ...rows.map((r) => rawValue(r, metric) ?? 0));
    for (const r of rows) {
      const v = rawValue(r, metric);
      out[r.section] = v == null ? null : v / max;
    }
    return out;
  }, [heat.data, metric, normalize]);

  /* Section chip text — the bare number the fill encodes. Which metric it is
     comes from the overlay, so the chip stays small. */
  const labelFor = useCallback(
    (r: StadiumSectionHeat): string | null => {
      if (metric === 'pct_sold') {
        return r.pct_sold == null ? null : `${Math.round(r.pct_sold * 100)}%`;
      }
      const raw = rawValue(r, metric);
      if (raw == null) return null;
      if (normalize) {
        const denom = metric === 'scans' ? r.occupied : r.total_seats;
        if (!denom) return null;
        return `${Math.round(Math.min(1, raw / denom) * 100)}%`;
      }
      return raw.toLocaleString('en-US');
    },
    [metric, normalize]
  );

  const isPctScale = metric === 'pct_sold' || normalize;
  const countMax = Math.max(0, ...(heat.data?.sections ?? []).map((r) => rawValue(r, metric) ?? 0));
  /* The overlay legend is too narrow for ten range labels, so it ticks the
     scale at both ends and the middle instead. */
  const scaleTick = (f: number): string =>
    isPctScale ? `${Math.round(f * 100)}%` : Math.round(f * countMax).toLocaleString();

  /* Stadium-wide figure for whatever metric is selected, so the overlay reads
     as a standalone summary. */
  const headline = ((): string => {
    if (!eventRow) return '—';
    switch (metric) {
      case 'pct_sold':
        return pct(eventRow.pct_sold);
      case 'sold':
        return num(eventRow.sold);
      case 'occupied':
        return num(eventRow.occupied);
      case 'comps':
        return num(comps(eventRow));
      case 'scans':
        if (eventRow.scanned == null) return '—';
        return normalize && eventRow.occupied
          ? pct(eventRow.scanned / eventRow.occupied)
          : num(eventRow.scanned);
    }
  })();

  const selectEvent = (name: string) => {
    setSelected(name);
    setSearch('');
    setPickerOpen(false);
    searchRef.current?.blur();
  };

  const renderGroup = (label: string, rows: StadiumEventRow[]) =>
    rows.length > 0 && (
      <div key={label}>
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        {rows.map((e) => (
          <button
            key={e.event_name}
            type="button"
            onMouseDown={(ev) => {
              ev.preventDefault();
              selectEvent(e.event_name);
            }}
            className="flex w-full items-baseline justify-between gap-4 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <span className="font-medium">
              {e.event_name}
              {e.event_name === events.data?.next_event ? ' (next)' : ''}
            </span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {fmtDate(e.event_date) || 'no date'}
            </span>
          </button>
        ))}
      </div>
    );

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Stadium Heat</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Section-by-section sales and attendance for Snapdragon Stadium, straight from the
          ticketing warehouse (refreshed three times an hour). Pick an event, hover a section for
          the numbers, scroll or pinch to zoom.
        </p>
      </div>

      {events.isError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load events</AlertTitle>
          <AlertDescription>{(events.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {eventRow ? (
          <>
            <StatTile
              gradient="azul"
              title="Seats sold"
              value={num(eventRow.sold)}
              description={`of ${num(eventRow.total_seats)} sellable`}
            />
            <StatTile
              gradient="chrome"
              title="Comps"
              value={num(comps(eventRow))}
              description={`${num(eventRow.occupied)} total tickets out`}
            />
            <StatTile
              gradient="orange"
              title="% sold"
              value={pct(eventRow.pct_sold)}
              description="overall sell-through"
            />
            <StatTile
              gradient="green"
              title="Scanned in"
              value={eventRow.scanned != null ? num(eventRow.scanned) : '—'}
              description={
                eventRow.scanned != null && eventRow.occupied
                  ? `${pct(eventRow.scanned / eventRow.occupied)} of tickets out`
                  : 'future event — no scans yet'
              }
            />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)
        )}
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {/* Navy panel header strip, talent-platform style */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 bg-sdfc-panel px-6 py-4">
          {/* The shown event now reads off the overlay on the map itself. */}
          <h2 className="self-center font-heading text-xl font-bold tracking-wide text-white">
            Section Heatmap
          </h2>

          {/* Dedicated search set: free text + date window, filtering the picker */}
          <div
            className="relative flex flex-wrap items-end gap-3"
            onFocusCapture={() => setPickerOpen(true)}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setPickerOpen(false);
            }}
          >
            <div className="grid gap-1">
              <span className="text-[10px] font-semibold tracking-wide text-white/60 uppercase">
                Show
              </span>
              <div
                role="group"
                aria-label="Filter events by date"
                className="flex h-8 items-center gap-0.5 rounded-lg border border-white/20 bg-white/10 p-0.5"
              >
                {EVENT_WHEN.map((w) => (
                  <button
                    key={w.key}
                    type="button"
                    aria-pressed={when === w.key}
                    onClick={() => setWhen(w.key)}
                    className={cn(
                      'h-full rounded-md px-3 text-xs font-medium transition-colors',
                      when === w.key
                        ? 'bg-white text-sdfc-azul shadow-sm'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    )}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-1">
              <label
                htmlFor="stadium-event-search"
                className="text-[10px] font-semibold tracking-wide text-white/60 uppercase"
              >
                Search
              </label>
              <Input
                id="stadium-event-search"
                ref={searchRef}
                value={search}
                placeholder={events.isPending ? 'Loading events…' : '6SD code or date…'}
                autoComplete="off"
                className="w-52 border-white/20 bg-white/10 text-white placeholder:text-white/50 focus-visible:ring-white/40"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setPickerOpen(false);
                    searchRef.current?.blur();
                  }
                  if (e.key === 'Enter') {
                    const first = grouped.upcoming[0] ?? grouped.past[0] ?? grouped.undated[0];
                    if (first) selectEvent(first.event_name);
                  }
                }}
              />
            </div>
            <div className="grid gap-1">
              <label
                htmlFor="stadium-date-from"
                className="text-[10px] font-semibold tracking-wide text-white/60 uppercase"
              >
                From
              </label>
              <Input
                id="stadium-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-38 border-white/20 bg-white/10 text-white [color-scheme:dark] focus-visible:ring-white/40"
              />
            </div>
            <div className="grid gap-1">
              <label
                htmlFor="stadium-date-to"
                className="text-[10px] font-semibold tracking-wide text-white/60 uppercase"
              >
                To
              </label>
              <Input
                id="stadium-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-38 border-white/20 bg-white/10 text-white [color-scheme:dark] focus-visible:ring-white/40"
              />
            </div>
            {(search || dateFrom || dateTo) && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSearch('');
                  setDateFrom('');
                  setDateTo('');
                }}
                className="pb-2 text-xs text-white/60 hover:text-white"
              >
                clear
              </button>
            )}
            {pickerOpen && (
              <div className="absolute top-full right-0 z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md">
                {renderGroup('Upcoming', grouped.upcoming)}
                {renderGroup('Past', grouped.past)}
                {renderGroup('Other', grouped.undated)}
                {grouped.upcoming.length + grouped.past.length + grouped.undated.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No events match the current search
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <CardContent className="grid gap-4 p-6">
          <div className="flex flex-wrap items-center gap-4">
            <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
              <TabsList>
                <TabsTrigger value="pct_sold">{METRIC_LABEL.pct_sold}</TabsTrigger>
                <TabsTrigger value="occupied">{METRIC_LABEL.occupied}</TabsTrigger>
                <TabsTrigger value="sold">{METRIC_LABEL.sold}</TabsTrigger>
                <TabsTrigger value="comps">{METRIC_LABEL.comps}</TabsTrigger>
                <TabsTrigger value="scans">{METRIC_LABEL.scans}</TabsTrigger>
              </TabsList>
            </Tabs>
            {metric !== 'pct_sold' && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={normalize}
                  onChange={(e) => setNormalize(e.target.checked)}
                  className="size-4 accent-sdfc-orange"
                />
                {metric === 'scans' ? 'scan rate (% of tickets out)' : '% of section capacity'}
              </label>
            )}
          </div>
          <div className="relative">
            {heat.isPending && <Skeleton className="aspect-[4/3] w-full rounded-lg" />}
            {heat.isError && (
              <Alert variant="destructive">
                <AlertTitle>Couldn't load section data</AlertTitle>
                <AlertDescription>{(heat.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {heat.data && (
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg">
                <StadiumHeatmap
                  heat={heat.data.sections}
                  values={values}
                  labelFor={labelFor}
                  onHover={setHover}
                />

                {/* Floating readout: which event, which metric, and the scale
                    to read the fills against — all without leaving the map. */}
                <div className="pointer-events-none absolute top-3 right-3 z-20 w-[330px] rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur-sm">
                  <div className="font-heading text-lg leading-tight font-bold">
                    {eventName ?? '…'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {eventRow?.event_date ? fmtDate(eventRow.event_date) : 'no date'}
                    {eventName && eventName === events.data?.next_event ? ' · next home event' : ''}
                  </div>

                  <div className="mt-3 flex items-end justify-between gap-3">
                    <span className="text-[11px] leading-tight font-semibold tracking-wide text-muted-foreground uppercase">
                      {METRIC_LABEL[metric]}
                      {metric === 'scans' && normalize ? (
                        <>
                          <br />
                          of tickets out
                        </>
                      ) : null}
                    </span>
                    <span className="font-heading text-3xl leading-none font-bold">{headline}</span>
                  </div>

                  <div
                    className="mt-3"
                    role="img"
                    aria-label={`${METRIC_LABEL[metric]} legend in ten steps`}
                  >
                    <div className="flex overflow-hidden rounded-sm">
                      {Array.from({ length: 10 }, (_, i) => (
                        <span key={i} className="h-5 flex-1" aria-hidden>
                          <span
                            className="block h-full w-full dark:hidden"
                            style={{ background: BUCKETS_LIGHT[i] }}
                          />
                          <span
                            className="hidden h-full w-full dark:block"
                            style={{ background: BUCKETS_DARK[i] }}
                          />
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] leading-none text-muted-foreground">
                      <span>{scaleTick(0)}</span>
                      <span>{scaleTick(0.5)}</span>
                      <span>{scaleTick(1)}</span>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span
                      className="size-3 shrink-0 rounded-sm dark:hidden"
                      style={{ background: NO_DATA_LIGHT }}
                      aria-hidden
                    />
                    <span
                      className="hidden size-3 shrink-0 rounded-sm dark:block"
                      style={{ background: NO_DATA_DARK }}
                      aria-hidden
                    />
                    {metric === 'scans' ? 'no scans / no inventory' : 'no inventory'}
                  </div>
                </div>
                {hover && (
                  <div
                    className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                    style={{
                      // flip to the other side of the cursor near the box edges
                      left: hover.x + (hover.x > hover.boxWidth - 190 ? -12 : 12),
                      top: hover.y + (hover.y > hover.boxHeight - 170 ? -12 : 12),
                      transform: `translate(${hover.x > hover.boxWidth - 190 ? '-100%' : '0'}, ${
                        hover.y > hover.boxHeight - 170 ? '-100%' : '0'
                      })`,
                    }}
                  >
                    <div className="text-sm font-semibold">{hover.section}</div>
                    <div className="text-muted-foreground capitalize">{hover.category}</div>
                    {hover.heat ? (
                      <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                        <span className="text-muted-foreground">Sold</span>
                        <span className="text-right font-medium">
                          {num(hover.heat.sold)} / {num(hover.heat.total_seats)}
                        </span>
                        <span className="text-muted-foreground">% sold</span>
                        <span className="text-right font-medium">{pct(hover.heat.pct_sold)}</span>
                        <span className="text-muted-foreground">Comps</span>
                        <span className="text-right font-medium">{num(comps(hover.heat))}</span>
                        {hover.heat.scanned != null && (
                          <>
                            <span className="text-muted-foreground">Scans</span>
                            <span className="text-right font-medium">
                              {num(hover.heat.scanned)}
                              {hover.heat.occupied
                                ? ` (${pct(hover.heat.scanned / hover.heat.occupied)})`
                                : ''}
                            </span>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 text-muted-foreground">No inventory for this event</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Scale and metric now live on the map overlay; this keeps the
                freshness stamp only. */}
            {heat.data && (
              <div className="mt-3 flex justify-end text-sm text-muted-foreground">
                <span>
                  Zoom in for more sections · data as of{' '}
                  {new Date(heat.data.generated_at).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
