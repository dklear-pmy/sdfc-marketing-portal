import { useMemo, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  api,
  type Tripwire,
  type TripwireCheckRow,
  type TripwireHistoryRow,
  type TripwireStatus,
  type TripwiresState,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { formatUtc, relativeFrom, shortIdentity } from "@/lib/format"
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

const checkLabel: Record<string, string> = {
  profile_exists: "Profile exists",
  subscription: "Subscription intact",
  transport: "Transport (24h)",
  sink_arrival: "Sink arrival",
  quiet: "Send recency",
  pmy_test_lint: "PMY-TEST lint",
}

const statusVariant: Record<TripwireStatus, "default" | "destructive" | "secondary" | "outline"> = {
  PASS: "secondary",
  WARN: "outline",
  FAIL: "destructive",
}

function overallBadge(overall: string) {
  if (overall === "FAIL") return <Badge variant="destructive">Failing</Badge>
  if (overall === "WARN")
    return (
      <Badge variant="outline" className="text-amber-600 dark:text-amber-500">
        Warnings
      </Badge>
    )
  if (overall === "PASS") return <Badge variant="default">OK</Badge>
  return <Badge variant="outline">{overall === "UNCHECKED" ? "Not checked yet" : overall}</Badge>
}

function CheckRow({ check }: { check: TripwireCheckRow }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Badge variant={statusVariant[check.status]} className="mt-0.5 shrink-0">
        {check.status}
      </Badge>
      <div className="min-w-0">
        <span className="font-medium">{checkLabel[check.check_name] ?? check.check_name}</span>
        {check.detail && (
          <span className="text-muted-foreground block truncate" title={check.detail}>
            {check.detail}
          </span>
        )}
      </div>
    </div>
  )
}

export default function Tripwires() {
  const { role } = useAuth()
  const canOperate = role === "operator" || role === "admin"
  const queryClient = useQueryClient()

  const state = useQuery<TripwiresState>({
    queryKey: ["tripwires"],
    queryFn: () => api.get("/api/tripwires"),
    refetchInterval: 60_000,
  })

  const runNow = useMutation({
    mutationFn: () => api.post<{ fail: number; warn: number; checks: number }>("/api/tripwires/run"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tripwires"] })
      void queryClient.invalidateQueries({ queryKey: ["tripwire-history"] })
    },
  })

  const data = state.data
  const failing = data?.tripwires.filter((t) => t.overall === "FAIL") ?? []
  const workspaceFailing = data?.workspace.overall === "FAIL"

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tripwire Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Persistent sink-backed profiles asserted daily: profile integrity, subscription state,
            transport, sink arrival and workspace lint.
          </p>
        </div>
        {canOperate && (
          <Button onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending ? "Running checks…" : "Run checks now"}
          </Button>
        )}
      </div>

      {runNow.isError && (
        <Alert variant="destructive">
          <AlertDescription>{(runNow.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {state.isPending && <Skeleton className="h-40" />}
      {state.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load tripwires</AlertTitle>
          <AlertDescription>{(state.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          {failing.length > 0 || workspaceFailing ? (
            <Alert variant="destructive">
              <AlertTitle>
                {failing.length > 0
                  ? `${failing.length} tripwire${failing.length > 1 ? "s" : ""} failing`
                  : "Workspace lint failing"}
              </AlertTitle>
              <AlertDescription>
                {failing.map((t) => t.label).join(", ")}
                {workspaceFailing && (failing.length > 0 ? " · " : "") + "PMY-TEST lint violation"}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertTitle>All clear</AlertTitle>
              <AlertDescription>
                {data.last_run_at
                  ? `Last checked ${relativeFrom(data.last_run_at)} (${formatUtc(data.last_run_at)}).`
                  : "No checks recorded yet — run checks or wait for the daily tick."}
              </AlertDescription>
            </Alert>
          )}

          <div className="grid items-start gap-4 lg:grid-cols-2">
            {data.tripwires.map((t) => (
              <TripwireCard key={t.email} tripwire={t} />
            ))}
            <Card className={cn(workspaceFailing && "border-destructive")}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">Workspace</CardTitle>
                  {overallBadge(data.workspace.overall)}
                </div>
                <CardDescription>
                  Workspace-wide assertions, independent of any tripwire account.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {data.workspace.checks.length === 0 && (
                  <p className="text-muted-foreground text-sm">Not checked yet.</p>
                )}
                {data.workspace.checks.map((c) => (
                  <CheckRow key={c.check_name} check={c} />
                ))}
              </CardContent>
            </Card>
          </div>

          {canOperate && <AddTripwireCard />}
          <HistoryCard />
        </>
      )}
    </div>
  )
}

function TripwireCard({ tripwire: t }: { tripwire: Tripwire }) {
  const lastChecked = t.checks[0]?.checked_at
  return (
    <Card className={cn(t.overall === "FAIL" && "border-destructive")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{t.label}</CardTitle>
          {overallBadge(t.overall)}
        </div>
        <CardDescription className="font-mono text-xs">{t.email}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {t.purpose && <p className="text-muted-foreground text-sm">{t.purpose}</p>}
        {t.checks.map((c) => (
          <CheckRow key={c.check_name} check={c} />
        ))}
        {t.checks.length === 0 && <p className="text-muted-foreground text-sm">Not checked yet.</p>}
        {lastChecked && (
          <p className="text-muted-foreground text-xs">
            Checked {relativeFrom(lastChecked)} · {formatUtc(lastChecked)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function AddTripwireCard() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [label, setLabel] = useState("")
  const [purpose, setPurpose] = useState("")
  const [quietDays, setQuietDays] = useState("")
  const [provision, setProvision] = useState(true)

  const add = useMutation({
    mutationFn: () =>
      api.post<{ email: string; provisioned: string | null }>("/api/tripwires", {
        email,
        label,
        purpose: purpose || null,
        max_quiet_days: quietDays ? Number(quietDays) : null,
        provision_slug: provision ? "Welcome-General-260715" : null,
      }),
    onSuccess: () => {
      setEmail("")
      setLabel("")
      setPurpose("")
      setQuietDays("")
      void queryClient.invalidateQueries({ queryKey: ["tripwires"] })
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    add.mutate()
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add tripwire</CardTitle>
        <CardDescription>
          Must be @qa.sdfc.dev (the sink only accepts that domain). Provisioning creates the CIO
          profile through the test welcome webhook.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor="tw-email">Email</Label>
            <Input
              id="tw-email"
              type="email"
              required
              placeholder="tripwire-something@qa.sdfc.dev"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid min-w-44 gap-1.5">
            <Label htmlFor="tw-label">Label</Label>
            <Input
              id="tw-label"
              required
              placeholder="e.g. STM listener"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid min-w-64 flex-1 gap-1.5">
            <Label htmlFor="tw-purpose">Purpose</Label>
            <Input
              id="tw-purpose"
              placeholder="What this tripwire watches for"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>
          <div className="grid w-32 gap-1.5">
            <Label htmlFor="tw-quiet">Quiet days</Label>
            <Input
              id="tw-quiet"
              type="number"
              min="1"
              placeholder="none"
              value={quietDays}
              onChange={(e) => setQuietDays(e.target.value)}
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={provision}
              onChange={(e) => setProvision(e.target.checked)}
            />
            Provision in CIO
          </label>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
        {add.isError && (
          <p className="text-destructive mt-2 text-sm">{(add.error as Error).message}</p>
        )}
        {add.isSuccess && add.data.provisioned && (
          <p className="text-muted-foreground mt-2 text-sm">
            Added and provisioned ({add.data.provisioned}).
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const HISTORY_STATUSES = ["ALL", "FAIL", "WARN", "PASS"] as const

function HistoryCard() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL")
  const history = useQuery<{ history: TripwireHistoryRow[] }>({
    queryKey: ["tripwire-history"],
    queryFn: () => api.get("/api/tripwires/history?limit=200"),
    refetchInterval: 60_000,
  })

  const rows = useMemo(() => {
    const all = history.data?.history ?? []
    return statusFilter === "ALL" ? all : all.filter((r) => r.status === statusFilter)
  }, [history.data, statusFilter])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Check history</CardTitle>
            <CardDescription>Most recent results, newest first.</CardDescription>
          </div>
          <Tabs value={statusFilter} onValueChange={setStatusFilter}>
            <TabsList>
              {HISTORY_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s === "ALL" ? "All" : s}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent>
        {history.isPending && <Skeleton className="h-24" />}
        {history.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(history.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {history.data && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Tripwire</TableHead>
                  <TableHead>Check</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground h-16 text-center">
                      No results{statusFilter !== "ALL" ? ` with status ${statusFilter}` : ""}.
                    </TableCell>
                  </TableRow>
                )}
                {rows.slice(0, 100).map((r, i) => (
                  <TableRow key={`${r.checked_at}-${r.email}-${r.check_name}-${i}`}>
                    <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                      {formatUtc(r.checked_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.email === "_workspace" ? "Workspace" : shortIdentity(r.email)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {checkLabel[r.check_name] ?? r.check_name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[r.status]}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="max-w-96">
                      <span className="block truncate" title={r.detail ?? ""}>
                        {r.detail ?? "—"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
