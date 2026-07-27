import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
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
} from "@/lib/api"
import { formatUnix, formatUtc, humanizeAttr, relativeFrom } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

export default function Fans() {
  const [email, setEmail] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)

  const lookup = useQuery<CustomerLookup>({
    queryKey: ["customer-lookup", submitted],
    queryFn: () => api.get(`/api/customers/lookup?email=${encodeURIComponent(submitted!)}`),
    enabled: !!submitted,
    staleTime: 30_000,
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = email.trim().toLowerCase()
    if (v) setSubmitted(v)
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Fans</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Look up a fan by email — live Customer.io profile, warehouse attributes and the activity
          ledger — or browse the latest active fans below.
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
              {lookup.isFetching ? "Looking up…" : "Look up"}
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
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {lookup.data && !lookup.isFetching && <LookupResult data={lookup.data} />}

      <FanList
        onSelect={(em) => {
          setEmail(em)
          setSubmitted(em)
          document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" })
        }}
      />
    </div>
  )
}

function LookupResult({ data }: { data: CustomerLookup }) {
  const { cio, warehouse, sync } = data

  if (!cio.found && !warehouse.found) {
    return (
      <Alert>
        <AlertTitle>No profile found</AlertTitle>
        <AlertDescription>
          {data.email} has no Customer.io profile and no warehouse fan_attributes row.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <IdentityCard data={data} />
        <SyncCard data={data} />
        <SnapshotCard row={warehouse.row} />
      </div>
      {sync.comparison.length > 0 && <AttributesCard comparison={sync.comparison} />}
      {cio.found && cio.cio_id && <ActivityCard cioId={cio.cio_id} />}
      <LedgerCard email={data.email} />
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="truncate text-right font-medium">{children}</span>
    </div>
  )
}

function IdentityCard({ data }: { data: CustomerLookup }) {
  const { cio, warehouse } = data
  const row = warehouse.row ?? {}
  const attrs = cio.attributes ?? {}
  const name =
    [attrs.first_name, attrs.last_name].filter(Boolean).join(" ") ||
    (row.full_name as string) ||
    "Unknown name"
  const segments = cio.segments ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{name}</CardTitle>
        <CardDescription className="break-all">{data.email}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={cio.found ? "default" : "outline"}>
            {cio.found ? "Customer.io profile" : "Not in Customer.io"}
          </Badge>
          <Badge variant={warehouse.found ? "default" : "outline"}>
            {warehouse.found ? "Warehouse row" : "Not in warehouse"}
          </Badge>
          {cio.found && (
            <Badge variant={cio.unsubscribed ? "destructive" : "secondary"}>
              {cio.unsubscribed ? "Unsubscribed" : "Subscribed"}
            </Badge>
          )}
        </div>
        {cio.found && (
          <Fact label="CIO ID">
            <span className="font-mono text-xs">{cio.cio_id}</span>
          </Fact>
        )}
        {typeof row.tm_acct_id === "string" && row.tm_acct_id && (
          <Fact label="TM account">{row.tm_acct_id}</Fact>
        )}
        {typeof row.sf_account_id === "string" && row.sf_account_id && (
          <Fact label="SF account">
            <span className="font-mono text-xs">{row.sf_account_id}</span>
          </Fact>
        )}
        {segments.length > 0 && (
          <div className="mt-1">
            <div className="text-muted-foreground mb-1.5 text-sm">
              Segments ({segments.length})
            </div>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {segments.map((s) => (
                <Badge key={s} variant="outline" className="font-normal">
                  {s.trim()}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SyncCard({ data }: { data: CustomerLookup }) {
  const { warehouse, sync, cio } = data
  const s = sync.summary
  const attention = (s.differs ?? 0) + (s.pending ?? 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sync status</CardTitle>
        <CardDescription>Warehouse → Customer.io reverse ETL</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-1.5">
          {sync.in_sync_view ? (
            <Badge variant="secondary">In sync view</Badge>
          ) : (
            <Badge variant="outline">Not in sync view</Badge>
          )}
          {sync.comparison.length > 0 &&
            (attention > 0 ? (
              <Badge variant="destructive">{attention} need attention</Badge>
            ) : (
              <Badge variant="default">Attributes in sync</Badge>
            ))}
        </div>
        {sync.excluded_reason && (
          <p className="text-muted-foreground text-sm">{sync.excluded_reason}</p>
        )}
        {!warehouse.found && (
          <p className="text-muted-foreground text-sm">
            No fan_attributes row — profiles created directly in Customer.io (imports, harness
            identities, trigger webhooks) appear in the warehouse after the next spine rebuild.
          </p>
        )}
        {warehouse.updated_at && (
          <Fact label="Row last changed">
            {formatUtc(warehouse.updated_at)}{" "}
            <span className="text-muted-foreground">({relativeFrom(warehouse.updated_at)})</span>
          </Fact>
        )}
        {warehouse.table_built_at && (
          <Fact label="Warehouse built">
            {formatUtc(warehouse.table_built_at)}{" "}
            <span className="text-muted-foreground">
              ({relativeFrom(warehouse.table_built_at)})
            </span>
          </Fact>
        )}
        {cio.last_attribute_write && (
          <Fact label="Last CIO write">
            {formatUtc(cio.last_attribute_write)}{" "}
            <span className="text-muted-foreground">
              ({relativeFrom(cio.last_attribute_write)})
            </span>
          </Fact>
        )}
        {sync.comparison.length > 0 && (
          <p className="text-muted-foreground text-sm">
            {s.match ?? 0} match · {s.differs ?? 0} differ · {s.pending ?? 0} pending ·{" "}
            {s.cio_only ?? 0} CIO-only · {s.empty ?? 0} empty
          </p>
        )}
      </CardContent>
    </Card>
  )
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
    )
  }
  const money = (v: unknown) =>
    typeof v === "number" ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null
  const facts: Array<[string, ReactNode]> = [
    ["Sprocket segment", [row.sprocket_macro, row.sprocket_sub_segment].filter(Boolean).join(" · ") || null],
    ["STM", (row.stm_product as string) || (row.stm_type as string) || null],
    ["Member status", (row.ticketing_member_status as string) || null],
    [
      "Matches attended",
      row.matches_attended_lifetime != null
        ? `${row.matches_attended_lifetime} lifetime · ${row.matches_attended_2026 ?? 0} in 2026`
        : null,
    ],
    ["Last attended", row.last_attendance_date ? formatUtc(String(row.last_attendance_date)) : null],
    ["Lifetime spend", money(row.lifetime_spend)],
    ["Shopify spend", money(row.shopify_amount_spent)],
    [
      "Next event",
      row.ticketing_event_name
        ? `${row.ticketing_event_name}${row.ticketing_event_date ? ` (${formatUtc(String(row.ticketing_event_date))})` : ""}`
        : null,
    ],
    ["Signup campaign", (row.tb_signup_campaign as string) || null],
  ]
  const present = facts.filter(([, v]) => v != null)
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fan snapshot</CardTitle>
        <CardDescription>From warehouse fan_attributes</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {present.length === 0 && (
          <p className="text-muted-foreground text-sm">No notable attributes populated.</p>
        )}
        {present.map(([label, value]) => (
          <Fact key={label} label={label}>
            {value}
          </Fact>
        ))}
      </CardContent>
    </Card>
  )
}

// ---- Attribute comparison table ----

const attrStatusMeta: Record<AttrStatus, { label: string; variant: "default" | "destructive" | "secondary" | "outline" }> = {
  match: { label: "Match", variant: "secondary" },
  differs: { label: "Differs", variant: "destructive" },
  pending: { label: "Pending sync", variant: "default" },
  cio_only: { label: "CIO only", variant: "outline" },
  empty: { label: "Empty", variant: "outline" },
}

const ATTR_TABS = [
  { key: "attention", label: "Needs attention", statuses: ["differs", "pending", "cio_only"] },
  { key: "match", label: "Match", statuses: ["match"] },
  { key: "all", label: "All", statuses: ["match", "differs", "pending", "cio_only", "empty"] },
] as const

function attrValue(v: unknown): string {
  if (v == null || v === "") return "—"
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

const attrCol = createColumnHelper<AttrComparison>()

function AttributesCard({ comparison }: { comparison: AttrComparison[] }) {
  const hasAttention = comparison.some((c) =>
    ["differs", "pending", "cio_only"].includes(c.status),
  )
  const [tab, setTab] = useState<string>(hasAttention ? "attention" : "all")
  const [search, setSearch] = useState("")

  const rows = useMemo(() => {
    const allowed = ATTR_TABS.find((t) => t.key === tab)?.statuses ?? []
    return comparison.filter((c) => (allowed as readonly string[]).includes(c.status))
  }, [comparison, tab])

  const columns = useMemo(
    () => [
      attrCol.accessor("name", {
        header: "Attribute",
        cell: (c) => (
          <div>
            <div className="font-medium">{humanizeAttr(c.getValue())}</div>
            <div className="text-muted-foreground font-mono text-xs">{c.getValue()}</div>
          </div>
        ),
      }),
      attrCol.accessor("warehouse", {
        header: "Warehouse",
        cell: (c) => (
          <span className="block max-w-56 truncate" title={attrValue(c.getValue())}>
            {attrValue(c.getValue())}
          </span>
        ),
      }),
      attrCol.accessor("cio", {
        header: "Customer.io",
        cell: (c) => (
          <span className="block max-w-56 truncate" title={attrValue(c.getValue())}>
            {attrValue(c.getValue())}
          </span>
        ),
      }),
      attrCol.accessor("status", {
        header: "Status",
        cell: (c) => {
          const meta = attrStatusMeta[c.getValue()]
          return <Badge variant={meta.variant}>{meta.label}</Badge>
        },
      }),
      attrCol.accessor("cio_updated_at", {
        header: "CIO updated",
        cell: (c) => {
          const v = c.getValue()
          return v ? (
            <span className="text-muted-foreground whitespace-nowrap text-xs">
              {relativeFrom(v)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      }),
    ],
    [],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { globalFilter: search },
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row, _col, value) => {
      const q = String(value).toLowerCase()
      const r = row.original
      return (
        r.name.toLowerCase().includes(q) ||
        humanizeAttr(r.name).toLowerCase().includes(q) ||
        attrValue(r.warehouse).toLowerCase().includes(q) ||
        attrValue(r.cio).toLowerCase().includes(q)
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 15 } },
  })

  const counts = useMemo(() => {
    const by: Record<string, number> = {}
    for (const c of comparison) by[c.status] = (by[c.status] ?? 0) + 1
    return {
      attention: (by.differs ?? 0) + (by.pending ?? 0) + (by.cio_only ?? 0),
      match: by.match ?? 0,
      all: comparison.length,
    } as Record<string, number>
  }, [comparison])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Attributes</CardTitle>
        <CardDescription>
          Sync payload vs the live Customer.io profile, per attribute.
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
                  <TableCell colSpan={columns.length} className="text-muted-foreground h-16 text-center">
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
          <span className="text-muted-foreground text-sm">
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
            <span className="text-muted-foreground text-sm">
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
  )
}

// ---- Activity timeline + delivery ledger ----

const activityLabel: Record<string, string> = {
  event: "Event",
  attribute_update: "Attributes updated",
  sent_email: "Email sent",
  delivered_email: "Email delivered",
  opened_email: "Email opened",
  clicked_email: "Email clicked",
  failed_email: "Email failed",
  bounced_email: "Email bounced",
  spammed_email: "Marked as spam",
  unsubscribed: "Unsubscribed",
  subscribed: "Subscribed",
  triggered_campaign: "Campaign triggered",
  entered_segment: "Entered segment",
  left_segment: "Left segment",
  sent_webhook: "Webhook sent",
}

const activityDot: Record<string, string> = {
  opened_email: "bg-emerald-500",
  clicked_email: "bg-emerald-500",
  delivered_email: "bg-sky-500",
  sent_email: "bg-sky-400",
  failed_email: "bg-red-500",
  bounced_email: "bg-red-500",
  spammed_email: "bg-red-500",
  unsubscribed: "bg-red-500",
  event: "bg-violet-500",
  attribute_update: "bg-amber-500",
}

function activityDetail(a: CioActivity): string {
  if (a.name) return String(a.name)
  const d = a.data ?? {}
  if (a.type === "attribute_update")
    return Object.keys(d)
      .filter((k) => !k.startsWith("_"))
      .slice(0, 6)
      .join(", ")
  if (typeof d.subject === "string") return d.subject
  if (d.template_id != null) return `Template ${d.template_id}`
  return ""
}

function messageStatus(m: CioMessage): { label: string; variant: "default" | "destructive" | "secondary" | "outline" } {
  const mt = m.metrics ?? {}
  if (m.failure_message) return { label: "Failed", variant: "destructive" }
  if (mt.bounced) return { label: "Bounced", variant: "destructive" }
  if (mt.clicked) return { label: "Clicked", variant: "default" }
  if (mt.opened) return { label: "Opened", variant: "default" }
  if (mt.delivered) return { label: "Delivered", variant: "secondary" }
  if (mt.sent) return { label: "Sent", variant: "secondary" }
  return { label: "Created", variant: "outline" }
}

function messageKind(m: CioMessage): string {
  if (m.newsletter_id != null) return "Newsletter"
  if (m.campaign_id != null) return "Campaign"
  if (m.transactional_message_id != null) return "Transactional"
  return m.type
}

function ActivityCard({ cioId }: { cioId: string }) {
  const [tab, setTab] = useState<"timeline" | "messages">("timeline")

  const activities = useInfiniteQuery<ActivitiesPage>({
    queryKey: ["customer-activities", cioId],
    queryFn: ({ pageParam }) =>
      api.get(
        `/api/customers/${cioId}/activities?limit=20${pageParam ? `&start=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === "timeline",
  })

  const messages = useInfiniteQuery<MessagesPage>({
    queryKey: ["customer-messages", cioId],
    queryFn: ({ pageParam }) =>
      api.get(
        `/api/customers/${cioId}/messages?limit=20${pageParam ? `&start=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === "messages",
  })

  const activityRows = activities.data?.pages.flatMap((p) => p.activities) ?? []
  const messageRows = messages.data?.pages.flatMap((p) => p.messages) ?? []
  const active = tab === "timeline" ? activities : messages

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Activity</CardTitle>
        <CardDescription>Live from Customer.io, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "timeline" | "messages")}>
          <TabsList>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
          </TabsList>
        </Tabs>

        {active.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(active.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {active.isPending && <Skeleton className="h-32" />}

        {tab === "timeline" && !activities.isPending && (
          <div className="grid">
            {activityRows.length === 0 && (
              <p className="text-muted-foreground py-4 text-sm">No activity recorded.</p>
            )}
            {activityRows.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 border-b py-2.5 text-sm last:border-b-0"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    activityDot[a.type] ?? "bg-muted-foreground/40",
                  )}
                />
                <span className="w-40 shrink-0 font-medium">
                  {activityLabel[a.type] ?? a.type.replace(/_/g, " ")}
                </span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  {activityDetail(a)}
                </span>
                <span className="text-muted-foreground shrink-0 whitespace-nowrap text-xs">
                  {formatUnix(a.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === "messages" && !messages.isPending && (
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
                    <TableCell colSpan={4} className="text-muted-foreground h-16 text-center">
                      No messages sent to this person.
                    </TableCell>
                  </TableRow>
                )}
                {messageRows.map((m) => {
                  const st = messageStatus(m)
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="max-w-80">
                        <span className="block truncate font-medium" title={m.subject ?? ""}>
                          {m.subject || "(no subject)"}
                        </span>
                        {m.failure_message && (
                          <span className="text-destructive block truncate text-xs">
                            {m.failure_message}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{messageKind(m)}</TableCell>
                      <TableCell>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {formatUnix(m.metrics?.sent ?? m.created)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {active.hasNextPage && (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void active.fetchNextPage()}
              disabled={active.isFetchingNextPage}
            >
              {active.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---- Latest active fans (server-paged browse list) ----

const FAN_PAGE = 20

function FanList({ onSelect }: { onSelect: (email: string) => void }) {
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [offset, setOffset] = useState(0)

  const list = useQuery<FanListPage>({
    queryKey: ["fan-list", q, offset],
    queryFn: () =>
      api.get(
        `/api/customers/list?limit=${FAN_PAGE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  })

  function onSearch(e: FormEvent) {
    e.preventDefault()
    setOffset(0)
    setQ(qInput.trim())
  }

  const money = (v: number | null) =>
    v != null ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"
  const data = list.data

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Latest active fans</CardTitle>
            <CardDescription>
              Subscribed fans, most recent attribute change first. Click a row for the full
              profile.
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
            <div className={cn("overflow-x-auto rounded-md border", list.isFetching && "opacity-60")}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fan</TableHead>
                    <TableHead>Segment</TableHead>
                    <TableHead>STM</TableHead>
                    <TableHead className="text-right">2026 matches</TableHead>
                    <TableHead>Last attended</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.fans.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground h-16 text-center">
                        No fans match{q ? ` “${q}”` : ""}.
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
                        <div className="font-medium">{f.full_name || "—"}</div>
                        <div className="text-muted-foreground text-xs">{f.email}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {f.sprocket_macro ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-44 truncate text-sm">
                        {f.stm_product ?? f.stm_type ?? f.ticketing_member_status ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {f.matches_attended_2026 ?? 0}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {f.last_attendance_date ? formatUtc(f.last_attendance_date) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm">{money(f.lifetime_spend)}</TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {relativeFrom(f.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">
                {data.total === 0
                  ? "0 fans"
                  : `${data.offset + 1}–${data.offset + data.fans.length} of ${data.total.toLocaleString()} fans`}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || list.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - FAN_PAGE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + FAN_PAGE >= data.total || list.isFetching}
                  onClick={() => setOffset(offset + FAN_PAGE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ---- Warehouse activity ledger (customer_events + customer_status_ledger) ----

const ledgerSourceDot: Record<string, string> = {
  customerio: "bg-sky-500",
  tradablebits: "bg-violet-500",
}

function ledgerStatusVariant(s: LedgerStatus): "default" | "destructive" | "secondary" | "outline" {
  if (/unsub|dropped|lapsed|inactive/i.test(s.status)) return "destructive"
  return "secondary"
}

function ledgerEventDetail(e: LedgerEvent): string {
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

function LedgerCard({ email }: { email: string }) {
  const ledger = useInfiniteQuery<FanLedgerPage>({
    queryKey: ["fan-ledger", email],
    queryFn: ({ pageParam }) =>
      api.get(`/api/customers/ledger?email=${encodeURIComponent(email)}&limit=25&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.offset + last.limit : undefined),
  })

  const statuses = ledger.data?.pages[0]?.statuses ?? []
  const events = ledger.data?.pages.flatMap((p) => p.events) ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Activity ledger</CardTitle>
        <CardDescription>
          Warehouse source of truth — status domains and the cross-source event stream
          (materialized hourly).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
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
                title={`authority: ${s.authority ?? "—"}${s.status_since ? ` · since ${formatUtc(s.status_since)}` : ""}`}
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
              <p className="text-muted-foreground py-3 text-sm">No ledger events for this fan.</p>
            )}
            {events.map((e) => (
              <div
                key={e.event_id}
                className={cn(
                  "flex items-center gap-3 border-b py-2.5 text-sm last:border-b-0",
                  e.is_system_echo && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    ledgerSourceDot[e.source_system ?? ""] ?? "bg-muted-foreground/40",
                  )}
                />
                <span className="w-44 shrink-0 font-medium">
                  {humanizeAttr(e.activity)}
                  {e.is_system_echo && <span className="text-muted-foreground ml-1 text-xs">(echo)</span>}
                </span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate" title={ledgerEventDetail(e)}>
                  {ledgerEventDetail(e)}
                </span>
                <span className="text-muted-foreground shrink-0 whitespace-nowrap text-xs">
                  {e.source_system ?? ""} · {formatUtc(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}

        {ledger.hasNextPage && (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void ledger.fetchNextPage()}
              disabled={ledger.isFetchingNextPage}
            >
              {ledger.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
