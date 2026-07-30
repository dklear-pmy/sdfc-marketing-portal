import { useMemo, useState, type FormEvent } from 'react';
import { useUrlFilters } from '@/lib/urlState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import {
  api,
  type ValidationReport,
  type CheckStatus,
  type HarnessRun,
  type HarnessRunSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  formatPacific,
  humanizeSlug,
  humanStage,
  relativeFrom,
  shortIdentity,
  statusLabel,
} from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import SlugRegistry from '@/components/SlugRegistry';

const checkVariant: Record<CheckStatus, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  pass: 'default',
  fail: 'destructive',
  warn: 'secondary',
  skip: 'outline',
};

const pairLabel: Record<string, string> = {
  test_trigger: 'Test · Trigger [1/2]',
  test_journey: 'Test · Journey [2/2]',
  prod_trigger: 'Prod · Trigger [1/2]',
  prod_journey: 'Prod · Journey [2/2]',
};

const runStatusVariant: Record<HarnessRun['status'], 'default' | 'destructive' | 'secondary'> = {
  RUNNING: 'secondary',
  PASSED: 'default',
  FAILED: 'destructive',
  TIMED_OUT: 'destructive',
};

const RUN_STATUSES = ['ALL', 'RUNNING', 'PASSED', 'FAILED', 'TIMED_OUT'] as const;

/* The run's stage machine, in order — the board shows each active run's
   position along it. */
const RUN_STAGES = [
  { key: 'fired', label: 'Fired' },
  { key: 'email1_engaged', label: 'Email 1' },
  { key: 'email2_engaged', label: 'Email 2' },
  { key: 'asserted', label: 'Verified' },
] as const;

function StageProgress({ stage }: { stage: string }) {
  const idx = Math.max(
    0,
    RUN_STAGES.findIndex((s) => s.key === stage)
  );
  return (
    <div className="flex items-start gap-1">
      {RUN_STAGES.map((s, i) => (
        <div key={s.key} className="min-w-0 flex-1">
          <div className={cn('h-1.5 rounded-full', i <= idx ? 'bg-primary' : 'bg-muted')} />
          <span
            className={cn(
              'mt-1 block truncate text-[10px]',
              i <= idx ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Harness() {
  /* The validated slug and the open run are the shareable bits — "look at this
     failing run" is the whole point of a link here. */
  const [url, setUrl] = useUrlFilters({ slug: '', run: '' });
  const slug = url.slug;
  const activeRunId = url.run || null;
  const setSlug = (v: string) => setUrl({ slug: v });
  const setActiveRunId = (v: string | null) => setUrl({ run: v ?? '' });
  const [formError, setFormError] = useState<string | null>(null);

  const validation = useMutation({
    mutationFn: (s: string) =>
      api.get<ValidationReport>(`/api/harness/validate/${encodeURIComponent(s)}`),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!slug.trim()) {
      setFormError('Enter a campaign slug first — the grey text is just an example.');
      return;
    }
    setFormError(null);
    validation.mutate(slug.trim());
  }

  const report = validation.data;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Campaign Tester</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prove a campaign works before any fan sees it — check its setup, then send a real
          end-to-end test to a safe test inbox.
        </p>
      </div>

      <SlugRegistry
        onValidate={(s) => {
          setSlug(s);
          setFormError(null);
          validation.mutate(s);
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Validate wiring</CardTitle>
          <CardDescription>
            Pick a registered campaign above, or enter any campaign's name code as it appears in
            Customer.io, e.g.{' '}
            <code className="rounded bg-muted px-1 py-0.5">Welcome-General-260715</code>. This
            confirms the test and live versions are wired identically before anything is sent.
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
              {validation.isPending ? 'Validating…' : 'Validate'}
            </Button>
          </form>
          {formError && <p className="mt-2 text-sm text-destructive">{formError}</p>}
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
              <CardTitle>{humanizeSlug(report.slug)} — campaign pairs</CardTitle>
              <CardDescription>
                {report.summary.fail === 0
                  ? 'All static checks passed.'
                  : `${report.summary.fail} check(s) failing.`}{' '}
                Generated {formatPacific(report.generated_at)}
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
                      <TableCell className="whitespace-nowrap">
                        {pairLabel[c.role] ?? c.role}
                      </TableCell>
                      <TableCell>{c.id}</TableCell>
                      <TableCell className="max-w-md truncate">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                          {c.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.event_name ?? '—'}</TableCell>
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
                        <Badge variant={checkVariant[check.status]}>{check.status}</Badge>
                      </TableCell>
                      <TableCell className="font-medium whitespace-nowrap">{check.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {check.detail}
                      </TableCell>
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

      <RunHistory activeRunId={activeRunId} onSelect={setActiveRunId} />

      {activeRunId && <RunDetail runId={activeRunId} onClose={() => setActiveRunId(null)} />}
    </div>
  );
}

function StartRunCard({
  slug,
  wiringClean,
  onStarted,
}: {
  slug: string;
  wiringClean: boolean;
  onStarted: (runId: string) => void;
}) {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const canRun = role === 'operator' || role === 'admin';

  const start = useMutation({
    mutationFn: () => api.post<HarnessRun>(`/api/harness/run/${encodeURIComponent(slug)}`),
    onSuccess: (run) => {
      onStarted(run.run_id);
      void queryClient.invalidateQueries({ queryKey: ['harness-runs'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run test campaign</CardTitle>
        <CardDescription>
          Sends the campaign's test twin to a brand-new test identity and follows it end to end —
          delivery, opens and clicks — without touching a single real fan. The first two emails
          verify in about 15 minutes; emails on multi-day timers arrive later in the test inbox and
          aren't awaited.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!canRun ? (
          <p className="text-sm text-muted-foreground">Requires the operator role.</p>
        ) : (
          <div className="flex items-center gap-3">
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Starting…' : `Start run for ${humanizeSlug(slug)}`}
            </Button>
            {!wiringClean && (
              <span className="text-sm text-muted-foreground">
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
  );
}

const columnHelper = createColumnHelper<HarnessRunSummary>();

function RunHistory({
  activeRunId,
  onSelect,
}: {
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const [{ runq }, setUrl] = useUrlFilters({ runq: '' });
  const globalFilter = runq;
  const setGlobalFilter = (v: string) => setUrl({ runq: v });
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const runsQuery = useQuery({
    queryKey: ['harness-runs'],
    queryFn: () => api.get<{ runs: HarnessRunSummary[] }>('/api/harness/runs?limit=200'),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'RUNNING') ? 30_000 : false,
  });

  const columns = useMemo(
    () => [
      columnHelper.accessor('started_at', {
        header: 'Started',
        cell: (info) => (
          <span className="text-sm whitespace-nowrap">{formatPacific(info.getValue())}</span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <Badge variant={runStatusVariant[info.getValue()]}>{statusLabel[info.getValue()]}</Badge>
        ),
        filterFn: 'equals',
      }),
      columnHelper.accessor('slug', {
        header: 'Campaign',
        cell: (info) => (
          <span className="whitespace-nowrap" title={info.getValue()}>
            {humanizeSlug(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('identity', {
        header: 'Identity',
        cell: (info) => (
          <code className="text-xs" title={info.getValue()}>
            {shortIdentity(info.getValue())}
          </code>
        ),
      }),
      columnHelper.accessor('stage', {
        header: 'Progress',
        cell: (info) => <span className="whitespace-nowrap">{humanStage(info.getValue())}</span>,
      }),
      columnHelper.accessor('detail', {
        header: 'Detail',
        cell: (info) => (
          <span className="block max-w-sm truncate text-sm text-muted-foreground">
            {info.getValue() ?? '—'}
          </span>
        ),
        enableGlobalFilter: false,
      }),
    ],
    []
  );

  const table = useReactTable({
    data: runsQuery.data?.runs ?? [],
    columns,
    state: { globalFilter, columnFilters },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue).toLowerCase();
      const r = row.original;
      return [r.run_id, r.slug, humanizeSlug(r.slug), r.identity, r.stage, r.status]
        .join(' ')
        .toLowerCase()
        .includes(q);
    },
    initialState: { pagination: { pageSize: 15 } },
    getRowId: (r) => r.run_id,
  });

  const statusFilter =
    (columnFilters.find((f) => f.id === 'status')?.value as string | undefined) ?? 'ALL';

  function setStatusFilter(value: string) {
    setColumnFilters(value === 'ALL' ? [] : [{ id: 'status', value }]);
    table.setPageIndex(0);
  }

  const pageCount = table.getPageCount();
  const pageIndex = table.getState().pagination.pageIndex;
  const active = (runsQuery.data?.runs ?? []).filter((r) => r.status === 'RUNNING');

  return (
    <>
      {active.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active runs</CardTitle>
            <CardDescription>
              Every test currently in flight — each advances on the 10-minute scheduler tick whether
              or not anyone is watching. Click one for its live timeline.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {active.map((r) => (
              <button
                key={r.run_id}
                type="button"
                onClick={() => onSelect(r.run_id)}
                className={cn(
                  'grid gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50',
                  r.run_id === activeRunId && 'bg-accent/50'
                )}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{humanizeSlug(r.slug)}</span>
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    started {relativeFrom(r.started_at)}
                  </span>
                </span>
                <code className="truncate text-xs text-muted-foreground">
                  {shortIdentity(r.identity)}
                </code>
                <StageProgress stage={r.stage} />
              </button>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Run history</CardTitle>
          <CardDescription>
            Every test run, newest first. Click a row for its full timeline — opening a running test
            resumes its progress tracking.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="max-w-xs"
              placeholder="Search campaign, identity, run id…"
              value={globalFilter}
              onChange={(e) => {
                setGlobalFilter(e.target.value);
                table.setPageIndex(0);
              }}
            />
            <Tabs value={statusFilter} onValueChange={setStatusFilter}>
              <TabsList>
                {RUN_STATUSES.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {s === 'ALL' ? 'All' : statusLabel[s]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {runsQuery.isError && (
            <Alert variant="destructive">
              <AlertTitle>Could not load runs</AlertTitle>
              <AlertDescription>{(runsQuery.error as Error).message}</AlertDescription>
            </Alert>
          )}

          {table.getRowModel().rows.length === 0 && !runsQuery.isPending && (
            <p className="text-sm text-muted-foreground">No runs match.</p>
          )}

          {table.getRowModel().rows.length > 0 && (
            <>
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
                  {table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      onClick={() => onSelect(row.original.run_id)}
                      className={cn('cursor-pointer', row.id === activeRunId && 'bg-accent/50')}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {table.getFilteredRowModel().rows.length} run(s)
                  {pageCount > 1 ? ` · page ${pageIndex + 1} of ${pageCount}` : ''}
                </span>
                {pageCount > 1 && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => table.previousPage()}
                      disabled={!table.getCanPreviousPage()}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => table.nextPage()}
                      disabled={!table.getCanNextPage()}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { role } = useAuth();
  const canAdvance = role === 'operator' || role === 'admin';

  const run = useQuery({
    queryKey: ['harness-run', runId, canAdvance],
    queryFn: () =>
      canAdvance
        ? api.post<HarnessRun>(`/api/harness/runs/${runId}/advance`)
        : api.get<HarnessRun>(`/api/harness/runs/${runId}`),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return !status || status === 'RUNNING' ? 20_000 : false;
    },
  });

  const current = run.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>
              {current
                ? `${humanizeSlug(current.slug)} · ${shortIdentity(current.identity)}`
                : 'Run detail'}
            </CardTitle>
            {/* When it ran is the useful context here. The run id lives in the
                URL (?run=…) for sharing, and who started it is noise — these
                are scheduled and operator runs against the same test pair. */}
            <CardDescription>
              {current
                ? `${formatPacific(current.started_at)} · ${relativeFrom(current.started_at)}`
                : ''}
            </CardDescription>
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
              <Badge variant={runStatusVariant[current.status]}>
                {statusLabel[current.status]}
              </Badge>
              <span className="text-muted-foreground">{humanStage(current.stage)}</span>
              {current.status === 'RUNNING' && canAdvance && (
                <span className="text-muted-foreground">advancing every 20s…</span>
              )}
            </div>
            {current.detail && <p className="text-sm">{current.detail}</p>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Time</TableHead>
                  <TableHead className="w-44">Stage</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.timeline.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatPacific(t.ts)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{humanStage(t.stage)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
