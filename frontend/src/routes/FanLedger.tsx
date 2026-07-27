import { useState, type ChangeEvent, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { useQuery } from "@tanstack/react-query"
import {
  api,
  type LedgerEventRow,
  type LedgerEventsPage,
  type LedgerStatusesPage,
} from "@/lib/api"
import { formatUtc, humanizeAttr, relativeFrom } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

const PAGE = 20
const WINDOWS = ["24h", "7d", "30d", "all"] as const

const selectCls =
  "border-input bg-card h-9 max-w-[400px] rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

function FacetSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  allLabel: string
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
  )
}

function Pager({
  total,
  offset,
  count,
  busy,
  onOffset,
}: {
  total: number
  offset: number
  count: number
  busy: boolean
  onOffset: (n: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-sm">
        {total === 0 ? "0 rows" : `${offset + 1}–${offset + count} of ${total.toLocaleString()}`}
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
  )
}

function eventDetail(e: LedgerEventRow): string {
  if (!e.feature_json) return ""
  try {
    const obj = JSON.parse(e.feature_json) as Record<string, unknown>
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== "" && v !== undefined)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ")
  } catch {
    return e.feature_json
  }
}

export default function FanLedger() {
  const [tab, setTab] = useState<"events" | "statuses">("events")
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Fan Ledger</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The audited record behind every fan-facing decision — what happened across all our
            systems (Events) and where each fan stands today (Statuses). Click any row to open
            the fan's full profile.
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="statuses">Statuses</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "events" ? <EventsTab /> : <StatusesTab />}
    </div>
  )
}

function EventsTab() {
  const navigate = useNavigate()
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("7d")
  const [activity, setActivity] = useState("")
  const [source, setSource] = useState("")
  const [includeEcho, setIncludeEcho] = useState(false)
  const [offset, setOffset] = useState(0)

  const query = useQuery<LedgerEventsPage>({
    queryKey: ["ledger-events", q, window, activity, source, includeEcho, offset],
    queryFn: () => {
      const p = new URLSearchParams({ window, limit: String(PAGE), offset: String(offset) })
      if (q) p.set("q", q)
      if (activity) p.set("activity", activity)
      if (source) p.set("source", source)
      if (includeEcho) p.set("include_echo", "true")
      return api.get(`/api/ledger/events?${p.toString()}`)
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })

  function reset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setOffset(0)
      setter(v)
    }
  }

  function onSearch(e: FormEvent) {
    e.preventDefault()
    setOffset(0)
    setQ(qInput.trim())
  }

  const data = query.data

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
          <Tabs value={window} onValueChange={(v) => reset(setWindow)(v as typeof window)}>
            <TabsList>
              {WINDOWS.map((w) => (
                <TabsTrigger key={w} value={w}>
                  {w === "all" ? "All time" : `Last ${w}`}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FacetSelect
            value={activity}
            onChange={reset(setActivity)}
            options={data?.activities ?? []}
            allLabel="All activities"
          />
          <FacetSelect
            value={source}
            onChange={reset(setSource)}
            options={data?.sources ?? []}
            allLabel="All sources"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeEcho}
              onChange={(e) => reset(setIncludeEcho)(e.target.checked)}
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
            <div className={cn("overflow-x-auto rounded-md border", query.isFetching && "opacity-60")}>
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
                      <TableCell colSpan={5} className="text-muted-foreground h-16 text-center">
                        No events match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.events.map((e) => (
                    <TableRow
                      key={e.event_id}
                      className={cn("cursor-pointer", e.is_system_echo && "opacity-60")}
                      onClick={() => navigate(`/fans?email=${encodeURIComponent(e.customer)}`)}
                    >
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        <div>{formatUtc(e.ts)}</div>
                        <div>{relativeFrom(e.ts)}</div>
                      </TableCell>
                      <TableCell className="max-w-56">
                        <span className="block truncate text-sm" title={e.customer}>
                          {e.customer}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm font-medium">
                        {humanizeAttr(e.activity)}
                        {e.is_system_echo && (
                          <span className="text-muted-foreground ml-1 text-xs">(echo)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {e.source_system ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-96">
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
              onOffset={setOffset}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function StatusesTab() {
  const navigate = useNavigate()
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [domain, setDomain] = useState("")
  const [status, setStatus] = useState("")
  const [latchedOnly, setLatchedOnly] = useState(false)
  const [offset, setOffset] = useState(0)

  const query = useQuery<LedgerStatusesPage>({
    queryKey: ["ledger-statuses", q, domain, status, latchedOnly, offset],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
      if (q) p.set("q", q)
      if (domain) p.set("domain", domain)
      if (status) p.set("status", status)
      if (latchedOnly) p.set("latched_only", "true")
      return api.get(`/api/ledger/statuses?${p.toString()}`)
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })

  function reset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setOffset(0)
      setter(v)
    }
  }

  function onSearch(e: FormEvent) {
    e.preventDefault()
    setOffset(0)
    setQ(qInput.trim())
  }

  const data = query.data

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
            onChange={reset(setDomain)}
            options={data?.domains ?? []}
            allLabel="All domains"
          />
          <FacetSelect
            value={status}
            onChange={reset(setStatus)}
            options={data?.status_values ?? []}
            allLabel="All statuses"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={latchedOnly}
              onChange={(e) => reset(setLatchedOnly)(e.target.checked)}
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
            <div className={cn("overflow-x-auto rounded-md border", query.isFetching && "opacity-60")}>
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
                      <TableCell colSpan={6} className="text-muted-foreground h-16 text-center">
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
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {humanizeAttr(s.status_domain)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={
                              /unsub|dropped|lapsed|inactive/i.test(s.status)
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {s.status}
                          </Badge>
                          {s.latched && <Badge variant="outline">latched</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {s.authority ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {s.status_since ? formatUtc(s.status_since) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {s.last_event_at ? relativeFrom(s.last_event_at) : "—"}
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
              onOffset={setOffset}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
