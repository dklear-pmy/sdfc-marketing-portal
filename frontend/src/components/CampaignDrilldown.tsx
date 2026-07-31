import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  type CheckStatus,
  type HarnessRun,
  type HarnessRunSummary,
  type PrecheckLevel,
  type SlugListResponse,
  type SlugPrecheck,
  type ValidationReport,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlFilters } from '@/lib/urlState';
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
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { SlugForm, toDraft, type Draft } from '@/components/SlugRegistry';
import SlugVariablesPanel from '@/components/SlugVariables';

/* Tabs follow the testing workflow left to right: is everything there →
   configure it → do the variables line up → full wiring check → fire and
   watch. */
export const CAMPAIGN_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'registration', label: 'Registration' },
  { key: 'variables', label: 'Variables' },
  { key: 'wiring', label: 'Wiring check' },
  { key: 'runs', label: 'Test runs' },
] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number]['key'];
export const CAMPAIGN_TAB_KEYS: readonly CampaignTab[] = CAMPAIGN_TABS.map((t) => t.key);

const runStatusVariant: Record<HarnessRun['status'], 'default' | 'destructive' | 'secondary'> = {
  RUNNING: 'secondary',
  PASSED: 'default',
  FAILED: 'destructive',
  TIMED_OUT: 'destructive',
};

const checkVariant: Record<CheckStatus, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  pass: 'default',
  fail: 'destructive',
  warn: 'secondary',
  skip: 'outline',
};

const findingVariant: Record<PrecheckLevel, 'destructive' | 'secondary' | 'outline'> = {
  fail: 'destructive',
  warn: 'secondary',
  info: 'outline',
};

const pairLabel: Record<string, string> = {
  test_trigger: 'Test · Trigger [1/2]',
  test_journey: 'Test · Journey [2/2]',
  prod_trigger: 'Prod · Trigger [1/2]',
  prod_journey: 'Prod · Journey [2/2]',
};

const RUN_STATUSES = ['ALL', 'RUNNING', 'PASSED', 'FAILED', 'TIMED_OUT'] as const;

const RUN_STAGES = [
  { key: 'fired', label: 'Fired' },
  { key: 'email1_engaged', label: 'Email 1' },
  { key: 'email2_engaged', label: 'Email 2' },
  { key: 'asserted', label: 'Verified' },
] as const;

export default function CampaignDrilldown({
  slug,
  tab,
  onTab,
  activeRunId,
  onSelectRun,
  onBack,
  onRun,
  runPending,
}: {
  slug: string;
  tab: CampaignTab;
  onTab: (tab: CampaignTab) => void;
  activeRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onBack: () => void;
  onRun: (slug: string) => void;
  runPending?: boolean;
}) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';

  const listQuery = useQuery({
    queryKey: ['slugs'],
    queryFn: () => api.get<SlugListResponse>('/api/slugs'),
  });
  const entry = listQuery.data?.slugs.find((e) => e.slug === slug);

  return (
    <div className="grid gap-6">
      <div>
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back to campaigns
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              {/* Display typography stays on the name span only — pills must
                  not inherit the large size or tight tracking. */}
              <CardTitle className="flex flex-wrap items-center gap-3">
                <span className="text-4xl font-medium tracking-tight">{humanizeSlug(slug)}</span>
                {/* Badge runs 25% over its default (h-5/text-xs) to hold its
                    own next to the display-size name. */}
                {entry && (
                  <Badge
                    variant={entry.runnable ? 'default' : 'secondary'}
                    className="h-[25px] px-2.5 text-[15px] tracking-normal"
                  >
                    {entry.runnable ? 'Runnable' : 'Not runnable'}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                <code className="text-xs">{slug}</code>
                {entry && (
                  <>
                    {' '}
                    · test <code className="text-xs">{entry.test_event_name ?? '—'}</code> · prod{' '}
                    <code className="text-xs">{entry.event_name ?? '—'}</code>
                    {entry.updated_at ? ` · updated ${relativeFrom(entry.updated_at)}` : ''}
                  </>
                )}
              </CardDescription>
              {entry?.notes && <p className="mt-2 text-sm text-muted-foreground">{entry.notes}</p>}
            </div>
            {canEdit && entry?.runnable && (
              <Button disabled={runPending} onClick={() => onRun(slug)}>
                {runPending ? 'Starting…' : 'Run test'}
              </Button>
            )}
          </div>
        </CardHeader>
      </Card>

      <UnderlineTabs tabs={CAMPAIGN_TABS} value={tab} onChange={onTab} />

      {tab === 'overview' && <OverviewTab slug={slug} />}
      {tab === 'registration' && (
        <RegistrationTab
          slug={slug}
          entryLoaded={!!entry}
          canEdit={canEdit}
          meta={listQuery.data}
        />
      )}
      {tab === 'variables' && <SlugVariablesPanel slug={slug} />}
      {tab === 'wiring' && <WiringTab slug={slug} />}
      {tab === 'runs' && (
        <>
          <ActiveRunsBoard slug={slug} activeRunId={activeRunId} onSelect={onSelectRun} />
          <RunHistory slug={slug} activeRunId={activeRunId} onSelect={onSelectRun} />
          {activeRunId && <RunDetail runId={activeRunId} onClose={() => onSelectRun(null)} />}
        </>
      )}
    </div>
  );
}

/* --- Overview: the live precheck — do the four campaigns exist and is the
   twin safely wired — plus what a run would send. --- */
function OverviewTab({ slug }: { slug: string }) {
  const precheck = useQuery({
    queryKey: ['precheck', slug],
    queryFn: () => api.get<SlugPrecheck>(`/api/slugs/${encodeURIComponent(slug)}/precheck`),
  });
  const report = precheck.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
        <CardDescription>
          Live check against Customer.io — campaign presence, states and convention findings.
          Fix-it-in-one-click offers live on the Registration tab's check.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {precheck.isPending && (
          <p className="text-sm text-muted-foreground">Checking Customer.io…</p>
        )}
        {precheck.isError && (
          <Alert variant="destructive">
            <AlertTitle>Precheck failed</AlertTitle>
            <AlertDescription>{(precheck.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {report && (
          <>
            <p className="text-sm font-medium">
              {report.campaigns.length} of 4 campaigns found
              {report.registered ? '' : ' · slug not registered yet'}
            </p>
            {report.campaigns.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {report.campaigns.map((c) => (
                  <span
                    key={c.role}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    title={c.name}
                  >
                    {pairLabel[c.role] ?? c.role} · #{c.id}
                    <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                      {c.state}
                    </Badge>
                  </span>
                ))}
              </div>
            )}
            <ul className="grid gap-1.5">
              {report.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Badge variant={findingVariant[f.level]} className="mt-0.5">
                    {f.level}
                  </Badge>
                  <span className="min-w-0 text-muted-foreground">{f.message}</span>
                </li>
              ))}
            </ul>
            {report.payload_preview && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground select-none">
                  Payload the runner will send —{' '}
                  {report.payload_is_custom ? 'this campaign’s template' : 'signup default'}
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
                  {JSON.stringify(report.payload_preview, null, 2)}
                </pre>
              </details>
            )}
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={precheck.isFetching}
              onClick={() => void precheck.refetch()}
            >
              {precheck.isFetching ? 'Checking…' : 'Re-check'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* --- Registration: the full editor, same form the register flow uses. --- */
function RegistrationTab({
  slug,
  entryLoaded,
  canEdit,
  meta,
}: {
  slug: string;
  entryLoaded: boolean;
  canEdit: boolean;
  meta: SlugListResponse | undefined;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const entry = meta?.slugs.find((e) => e.slug === slug);

  useEffect(() => {
    if (entry && draft === null) setDraft(toDraft(entry));
  }, [entry, draft]);

  if (!canEdit) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Registration is read-only for viewers — ask an operator to change this campaign's entry.
        </CardContent>
      </Card>
    );
  }
  if (!entryLoaded || !draft) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">Loading entry…</CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="pt-6">
        <SlugForm
          existingSlug={slug}
          draft={draft}
          setDraft={setDraft as Dispatch<SetStateAction<Draft>>}
          defaultTemplate={meta?.default_payload_template ?? ''}
          tokens={meta?.payload_tokens ?? {}}
          onClose={() => setDraft(entry ? toDraft(entry) : null)}
          onCommitted={() => setDraft(null)}
        />
      </CardContent>
    </Card>
  );
}

/* --- Wiring check: the full static validator, auto-run on open. --- */
function WiringTab({ slug }: { slug: string }) {
  const validation = useQuery({
    queryKey: ['validate', slug],
    queryFn: () => api.get<ValidationReport>(`/api/harness/validate/${encodeURIComponent(slug)}`),
  });
  const report = validation.data;

  return (
    <div className="grid gap-6">
      {validation.isPending && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Running the full wiring validation — several Customer.io reads, takes a few seconds…
          </CardContent>
        </Card>
      )}
      {validation.isError && (
        <Alert variant="destructive">
          <AlertTitle>Validation request failed</AlertTitle>
          <AlertDescription>{(validation.error as Error).message}</AlertDescription>
        </Alert>
      )}
      {report && (
        <ValidationReportView
          report={report}
          onRevalidate={() => void validation.refetch()}
          revalidating={validation.isFetching}
        />
      )}
    </div>
  );
}

export function ValidationReportView({
  report,
  onRevalidate,
  revalidating,
}: {
  report: ValidationReport;
  onRevalidate?: () => void;
  revalidating?: boolean;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>{humanizeSlug(report.slug)} — campaign pairs</CardTitle>
              <CardDescription>
                {report.summary.fail === 0
                  ? 'All static checks passed.'
                  : `${report.summary.fail} check(s) failing.`}{' '}
                Generated {formatPacific(report.generated_at)}
              </CardDescription>
            </div>
            {onRevalidate && (
              <Button variant="outline" size="sm" disabled={revalidating} onClick={onRevalidate}>
                {revalidating ? 'Validating…' : 'Re-validate'}
              </Button>
            )}
          </div>
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
                  <TableCell className="whitespace-nowrap">{pairLabel[c.role] ?? c.role}</TableCell>
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
                  <TableCell className="text-sm text-muted-foreground">{check.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

/* --- Test runs (campaign-scoped) --- */

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

function ActiveRunsBoard({
  slug,
  activeRunId,
  onSelect,
}: {
  slug: string;
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const runsQuery = useQuery({
    queryKey: ['harness-runs'],
    queryFn: () => api.get<{ runs: HarnessRunSummary[] }>('/api/harness/runs?limit=200'),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'RUNNING') ? 30_000 : false,
  });
  const active = (runsQuery.data?.runs ?? []).filter(
    (r) => r.status === 'RUNNING' && r.slug === slug
  );
  if (active.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active runs</CardTitle>
        <CardDescription>
          Tests of this campaign currently in flight — each advances on the 10-minute scheduler tick
          whether or not anyone is watching. Click one for its live timeline.
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
  );
}

const columnHelper = createColumnHelper<HarnessRunSummary>();

function RunHistory({
  slug,
  activeRunId,
  onSelect,
}: {
  slug: string;
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

  const data = useMemo(
    () => (runsQuery.data?.runs ?? []).filter((r) => r.slug === slug),
    [runsQuery.data, slug]
  );

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
    data,
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
      return [r.run_id, r.identity, r.stage, r.status].join(' ').toLowerCase().includes(q);
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          Every test of this campaign, newest first. Click a row for its full timeline — opening a
          running test resumes its progress tracking.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="max-w-xs"
            placeholder="Search identity, run id…"
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
