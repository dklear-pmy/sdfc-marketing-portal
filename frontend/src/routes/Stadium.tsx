import { useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  api,
  type StadiumEventRow,
  type StadiumEventsResponse,
  type StadiumHeatResponse,
  type StadiumSectionHeat,
} from "@/lib/api"
import StadiumHeatmap, {
  type HoverInfo,
  BUCKETS_DARK,
  BUCKETS_LIGHT,
  NO_DATA_DARK,
  NO_DATA_LIGHT,
} from "@/components/StadiumHeatmap"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Metric = "pct_sold" | "occupied" | "sold" | "comps" | "scans"

// "occupied" = seats with status SOLD or COMP in the latest snapshot — the
// expected occupancy (paid + comps), not attendance. "scans" = distinct seats
// with an accepted entry scan (valid=Y, result A) — only past events have them.
const METRIC_LABEL: Record<Metric, string> = {
  pct_sold: "% sold",
  occupied: "Sold + comps",
  sold: "Sold",
  comps: "Comps",
  scans: "Scans",
}

function fmtDate(d: string | null): string {
  if (!d) return ""
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`
}

function num(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString("en-US")
}

function comps(r: { occupied: number | null; sold: number | null }): number | null {
  return r.occupied != null && r.sold != null ? r.occupied - r.sold : null
}

function rawValue(r: StadiumSectionHeat, metric: Metric): number | null {
  switch (metric) {
    case "sold":
      return r.sold
    case "occupied":
      return r.occupied
    case "comps":
      return comps(r)
    case "scans":
      return r.scanned
    default:
      return null
  }
}

interface EventGroups {
  upcoming: StadiumEventRow[]
  past: StadiumEventRow[]
  undated: StadiumEventRow[]
}

export default function Stadium() {
  const [selected, setSelected] = useState<string | null>(null)
  const [metric, setMetric] = useState<Metric>("pct_sold")
  const [normalize, setNormalize] = useState(true)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [search, setSearch] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const events = useQuery<StadiumEventsResponse>({
    queryKey: ["stadium-events"],
    queryFn: () => api.get("/api/stadium-heat/events"),
    staleTime: 5 * 60_000,
  })

  const eventName = selected ?? events.data?.next_event ?? null
  const heat = useQuery<StadiumHeatResponse>({
    queryKey: ["stadium-heat", eventName],
    queryFn: () => api.get(`/api/stadium-heat?event=${encodeURIComponent(eventName!)}`),
    enabled: !!eventName,
    staleTime: 5 * 60_000,
  })

  /* Search matches the 6SD code and the date in both ISO and pretty forms. */
  const grouped: EventGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = (events.data?.events ?? []).filter(
      (r) =>
        !q ||
        r.event_name.toLowerCase().includes(q) ||
        (r.event_date ?? "").includes(q) ||
        fmtDate(r.event_date).toLowerCase().includes(q),
    )
    const today = new Date().toISOString().slice(0, 10)
    return {
      upcoming: rows
        .filter((r) => r.event_date && r.event_date >= today)
        .sort((a, b) => a.event_date!.localeCompare(b.event_date!)),
      past: rows
        .filter((r) => r.event_date && r.event_date < today)
        .sort((a, b) => b.event_date!.localeCompare(a.event_date!)),
      undated: rows.filter((r) => !r.event_date),
    }
  }, [events.data, search])

  const eventRow = events.data?.events.find((e) => e.event_name === eventName)

  /* Normalized 0..1 value per section for the stepped ramp. Scans normalize
     against tickets out (sold + comps) — the show-up rate; the count metrics
     against section capacity. */
  const values = useMemo(() => {
    const out: Record<string, number | null> = {}
    const rows = heat.data?.sections ?? []
    if (metric === "pct_sold") {
      for (const r of rows) out[r.section] = r.pct_sold
      return out
    }
    if (normalize) {
      for (const r of rows) {
        const v = rawValue(r, metric)
        const denom = metric === "scans" ? r.occupied : r.total_seats
        out[r.section] = v == null || !denom ? null : Math.min(1, v / denom)
      }
      return out
    }
    const max = Math.max(1, ...rows.map((r) => rawValue(r, metric) ?? 0))
    for (const r of rows) {
      const v = rawValue(r, metric)
      out[r.section] = v == null ? null : v / max
    }
    return out
  }, [heat.data, metric, normalize])

  const isPctScale = metric === "pct_sold" || normalize
  const countMax = Math.max(
    0,
    ...(heat.data?.sections ?? []).map((r) => rawValue(r, metric) ?? 0),
  )
  const bucketLabel = (i: number): string => {
    if (isPctScale) return i === 9 ? "90–100%" : `${i * 10}–${i * 10 + 9}%`
    const lo = Math.round((i / 10) * countMax)
    const hi = i === 9 ? countMax : Math.round(((i + 1) / 10) * countMax) - 1
    return `${lo.toLocaleString()}–${hi.toLocaleString()}`
  }

  const selectEvent = (name: string) => {
    setSelected(name)
    setSearch("")
    setPickerOpen(false)
    searchRef.current?.blur()
  }

  const renderGroup = (label: string, rows: StadiumEventRow[]) =>
    rows.length > 0 && (
      <div key={label}>
        <div className="text-muted-foreground px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
          {label}
        </div>
        {rows.map((e) => (
          <button
            key={e.event_name}
            type="button"
            onMouseDown={(ev) => {
              ev.preventDefault()
              selectEvent(e.event_name)
            }}
            className="hover:bg-accent flex w-full items-baseline justify-between gap-4 px-3 py-1.5 text-left text-sm"
          >
            <span className="font-medium">
              {e.event_name}
              {e.event_name === events.data?.next_event ? " (next)" : ""}
            </span>
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              {fmtDate(e.event_date) || "no date"}
            </span>
          </button>
        ))}
      </div>
    )

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Stadium Heat</h1>
        <p className="text-muted-foreground mt-1 text-sm">
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

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="relative grid gap-1.5">
              <Label htmlFor="stadium-event-search">Event</Label>
              <Input
                id="stadium-event-search"
                ref={searchRef}
                value={pickerOpen ? search : (eventName ?? "")}
                placeholder={
                  events.isPending ? "Loading events…" : "Search 6SD code or date…"
                }
                autoComplete="off"
                className="min-w-72"
                onFocus={() => {
                  setPickerOpen(true)
                  setSearch("")
                }}
                onBlur={() => setPickerOpen(false)}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setPickerOpen(false)
                    searchRef.current?.blur()
                  }
                  if (e.key === "Enter") {
                    const first =
                      grouped.upcoming[0] ?? grouped.past[0] ?? grouped.undated[0]
                    if (first) selectEvent(first.event_name)
                  }
                }}
              />
              {pickerOpen && (
                <div className="bg-popover text-popover-foreground absolute top-full z-20 mt-1 max-h-80 w-full min-w-72 overflow-y-auto rounded-md border py-1 shadow-md">
                  {renderGroup("Upcoming", grouped.upcoming)}
                  {renderGroup("Past", grouped.past)}
                  {renderGroup("Other", grouped.undated)}
                  {grouped.upcoming.length + grouped.past.length + grouped.undated.length ===
                    0 && (
                    <div className="text-muted-foreground px-3 py-2 text-sm">
                      No events match "{search}"
                    </div>
                  )}
                </div>
              )}
            </div>

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
              {metric !== "pct_sold" && (
                <label className="text-muted-foreground flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={normalize}
                    onChange={(e) => setNormalize(e.target.checked)}
                    className="accent-sdfc-orange size-4"
                  />
                  {metric === "scans" ? "scan rate (% of tickets out)" : "% of section capacity"}
                </label>
              )}
            </div>
          </div>

          {eventRow && (
            <CardDescription className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                <span className="text-foreground font-medium">{num(eventRow.sold)}</span> sold
              </span>
              <span>
                <span className="text-foreground font-medium">{num(comps(eventRow))}</span> comps
              </span>
              {eventRow.scanned != null && (
                <span>
                  <span className="text-foreground font-medium">{num(eventRow.scanned)}</span>{" "}
                  scanned in
                  {eventRow.occupied ? ` (${pct(eventRow.scanned / eventRow.occupied)})` : ""}
                </span>
              )}
              <span>
                <span className="text-foreground font-medium">{num(eventRow.total_seats)}</span>{" "}
                sellable seats
              </span>
              <span>
                <span className="text-foreground font-medium">{pct(eventRow.pct_sold)}</span> sold
                overall
              </span>
            </CardDescription>
          )}
        </CardHeader>

        <CardContent>
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
                <StadiumHeatmap heat={heat.data.sections} values={values} onHover={setHover} />
                {hover && (
                  <div
                    className="bg-popover text-popover-foreground pointer-events-none absolute z-10 rounded-md border px-3 py-2 text-xs shadow-md"
                    style={{
                      // flip to the other side of the cursor near the box edges
                      left: hover.x + (hover.x > hover.boxWidth - 190 ? -12 : 12),
                      top: hover.y + (hover.y > hover.boxHeight - 170 ? -12 : 12),
                      transform: `translate(${hover.x > hover.boxWidth - 190 ? "-100%" : "0"}, ${
                        hover.y > hover.boxHeight - 170 ? "-100%" : "0"
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
                                : ""}
                            </span>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-muted-foreground mt-1">No inventory for this event</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {heat.data && (
              <div className="text-muted-foreground mt-3 flex flex-wrap items-end gap-x-6 gap-y-2 text-xs">
                <div className="flex items-end gap-3">
                  <div
                    className="flex items-end"
                    role="img"
                    aria-label={`${METRIC_LABEL[metric]} legend in ten steps`}
                  >
                    {Array.from({ length: 10 }, (_, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span
                          className="h-3 w-9 first:rounded-l-sm dark:hidden"
                          style={{ background: BUCKETS_LIGHT[i] }}
                          aria-hidden
                        />
                        <span
                          className="hidden h-3 w-9 dark:inline-block"
                          style={{ background: BUCKETS_DARK[i] }}
                          aria-hidden
                        />
                        <span className="text-[9px] leading-none">{bucketLabel(i)}</span>
                      </div>
                    ))}
                  </div>
                  <span className="pb-0.5">
                    {METRIC_LABEL[metric]}
                    {metric === "scans" && normalize ? " (of tickets out)" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 pb-0.5">
                  <span
                    className="size-2.5 rounded-sm dark:hidden"
                    style={{ background: NO_DATA_LIGHT }}
                    aria-hidden
                  />
                  <span
                    className="hidden size-2.5 rounded-sm dark:inline-block"
                    style={{ background: NO_DATA_DARK }}
                    aria-hidden
                  />
                  <span>{metric === "scans" ? "no scans / no inventory" : "no inventory"}</span>
                </div>
                <span className="ml-auto pb-0.5">
                  Zoom in for more sections · data as of{" "}
                  {new Date(heat.data.generated_at).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
