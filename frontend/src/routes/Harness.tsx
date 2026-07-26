import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  api,
  type ValidationReport,
  type CheckStatus,
  type HarnessRun,
  type HarnessRunSummary,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

const statusVariant: Record<CheckStatus, "default" | "destructive" | "secondary" | "outline"> = {
  pass: "default",
  fail: "destructive",
  warn: "secondary",
  skip: "outline",
}

const roleLabel: Record<string, string> = {
  test_trigger: "Test · Trigger [1/2]",
  test_journey: "Test · Journey [2/2]",
  prod_trigger: "Prod · Trigger [1/2]",
  prod_journey: "Prod · Journey [2/2]",
}

const runStatusVariant: Record<HarnessRun["status"], "default" | "destructive" | "secondary"> = {
  RUNNING: "secondary",
  PASSED: "default",
  FAILED: "destructive",
  TIMED_OUT: "destructive",
}

const RUN_STATUSES = ["ALL", "RUNNING", "PASSED", "FAILED", "TIMED_OUT"] as const

export default function Harness() {
  const [slug, setSlug] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const validation = useMutation({
    mutationFn: (s: string) => api.get<ValidationReport>(`/api/harness/validate/${encodeURIComponent(s)}`),
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!slug.trim()) {
      setFormError("Enter a campaign slug first — the grey text is just an example.")
      return
    }
    setFormError(null)
    validation.mutate(slug.trim())
  }

  const report = validation.data

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Campaign Test Harness</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Validate a campaign's CIO wiring by slug, then run it end-to-end against the mail sink.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Validate wiring</CardTitle>
          <CardDescription>
            Enter the campaign slug as it appears in the CIO campaign names, e.g.{" "}
            <code className="bg-muted rounded px-1 py-0.5">Welcome-General-260715</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex items-end gap-3">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="slug">Campaign slug</Label>
              <Input
                id="slug"
                required
                placeholder="e.g. Welcome-General-260715"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={validation.isPending}>
              {validation.isPending ? "Validating…" : "Validate"}
            </Button>
          </form>
          {formError && <p className="text-destructive mt-2 text-sm">{formError}</p>}
        </CardContent>
      </Card>

      {validation.isError && (
        <Alert variant="destructive">
          <AlertTitle>Validation request failed</AlertTitle>
          <AlertDescription>{(validation.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Campaign pairs</CardTitle>
              <CardDescription>
                {report.summary.fail === 0
                  ? "All static checks passed."
                  : `${report.summary.fail} check(s) failing.`}{" "}
                Generated {new Date(report.generated_at).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Trigger event</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.campaigns.map((c) => (
                    <TableRow key={c.role}>
                      <TableCell className="whitespace-nowrap">{roleLabel[c.role] ?? c.role}</TableCell>
                      <TableCell>{c.id}</TableCell>
                      <TableCell className="max-w-md truncate">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant={c.state === "running" ? "default" : "secondary"}>
                          {c.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.event_name ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead>Check</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.checks.map((check) => (
                    <TableRow key={check.id}>
                      <TableCell>
                        <Badge variant={statusVariant[check.status]}>{check.status}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{check.name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{check.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <StartRunCard
            slug={report.slug}
            wiringClean={report.summary.fail === 0}
            onStarted={setActiveRunId}
          />
        </>
      )}

      {activeRunId && <RunDetail runId={activeRunId} onClose={() => setActiveRunId(null)} />}

      <RunHistory activeRunId={activeRunId} onSelect={setActiveRunId} />
    </div>
  )
}

function StartRunCard({
  slug,
  wiringClean,
  onStarted,
}: {
  slug: string
  wiringClean: boolean
  onStarted: (runId: string) => void
}) {
  const { role } = useAuth()
  const queryClient = useQueryClient()
  const canRun = role === "operator" || role === "admin"

  const start = useMutation({
    mutationFn: () => api.post<HarnessRun>(`/api/harness/run/${encodeURIComponent(slug)}`),
    onSuccess: (run) => {
      onStarted(run.run_id)
      void queryClient.invalidateQueries({ queryKey: ["harness-runs"] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run test campaign</CardTitle>
        <CardDescription>
          Fires the PMY-TEST pair with a fresh scenario identity, then tracks delivery and
          engagement through the mail sink. Emails 1–2 verify in ~15 minutes; later journey
          emails ride long timers and are not awaited.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!canRun ? (
          <p className="text-muted-foreground text-sm">Requires the operator role.</p>
        ) : (
          <div className="flex items-center gap-3">
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Starting…" : `Start run for ${slug}`}
            </Button>
            {!wiringClean && (
              <span className="text-muted-foreground text-sm">
                Heads-up: static checks have failures — the run will likely surface them.
              </span>
            )}
          </div>
        )}
        {start.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not start run</AlertTitle>
            <AlertDescription>{(start.error as Error).message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { role } = useAuth()
  const canAdvance = role === "operator" || role === "admin"

  // Operators advance the run as they watch; viewers just read its state.
  const run = useQuery({
    queryKey: ["harness-run", runId, canAdvance],
    queryFn: () =>
      canAdvance
        ? api.post<HarnessRun>(`/api/harness/runs/${runId}/advance`)
        : api.get<HarnessRun>(`/api/harness/runs/${runId}`),
    refetchInterval: (q) => {
      const status = q.state.data?.status
      return !status || status === "RUNNING" ? 20_000 : false
    },
  })

  const current = run.data

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Run {runId}</CardTitle>
            {current && (
              <CardDescription>
                {current.slug} · {current.identity}
                {current.started_by ? ` · started by ${current.started_by}` : ""}
              </CardDescription>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {run.isError && (
          <Alert variant="destructive">
            <AlertTitle>Polling hiccup (will retry)</AlertTitle>
            <AlertDescription>{(run.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {current && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant={runStatusVariant[current.status]}>{current.status}</Badge>
              <span className="text-muted-foreground">stage {current.stage}</span>
              {current.status === "RUNNING" && canAdvance && (
                <span className="text-muted-foreground">advancing every 20s…</span>
              )}
            </div>
            {current.detail && <p className="text-sm">{current.detail}</p>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Time (UTC)</TableHead>
                  <TableHead className="w-40">Stage</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.timeline.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">
                      {new Date(t.ts).toISOString().slice(0, 19).replace("T", " ")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t.stage}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{t.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function RunHistory({
  activeRunId,
  onSelect,
}: {
  activeRunId: string | null
  onSelect: (runId: string) => void
}) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<(typeof RUN_STATUSES)[number]>("ALL")

  const runs = useQuery({
    queryKey: ["harness-runs", search, status],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search.trim()) params.set("q", search.trim())
      if (status !== "ALL") params.set("status", status)
      params.set("limit", "50")
      return api.get<{ runs: HarnessRunSummary[] }>(`/api/harness/runs?${params}`)
    },
    // Refresh the list while anything is in flight.
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === "RUNNING") ? 30_000 : false,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          Every harness run, newest first. Click a row for its full timeline — opening a
          RUNNING run resumes its progress tracking.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="max-w-xs"
            placeholder="Search slug, identity, run id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <TabsList>
              {RUN_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s === "ALL" ? "All" : s.replace("_", " ")}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {runs.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load runs</AlertTitle>
            <AlertDescription>{(runs.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {runs.data && runs.data.runs.length === 0 && (
          <p className="text-muted-foreground text-sm">No runs match.</p>
        )}

        {runs.data && runs.data.runs.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started (UTC)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.runs.map((r) => (
                <TableRow
                  key={r.run_id}
                  onClick={() => onSelect(r.run_id)}
                  className={cn(
                    "cursor-pointer",
                    r.run_id === activeRunId && "bg-accent/50",
                  )}
                >
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {r.started_at.slice(0, 19).replace("T", " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={runStatusVariant[r.status]}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{r.slug}</TableCell>
                  <TableCell className="font-mono text-xs">{r.identity}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.stage}</TableCell>
                  <TableCell className="text-muted-foreground max-w-sm truncate text-sm">
                    {r.detail ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
