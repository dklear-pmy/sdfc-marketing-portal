import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type SpendDagRow,
  type SpendDagsResponse,
  type SpendFinding,
  type SpendSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatPacific, relativeFrom } from '@/lib/format';
import { oneOf, useUrlFilters } from '@/lib/urlState';
import {
  deltaClass,
  KIND_LABEL,
  STATE_LABEL,
  STATE_VARIANT,
  STATUS_LABEL,
  STATUS_VARIANT,
  usd,
  usdDelta,
} from '@/lib/spend';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UnderlineTabs } from '@/components/ui/underline-tabs';
import { HourHeatmap } from '@/components/HourHeatmap';
import { Sparkline } from '@/components/Sparkline';
import { DagDrilldown } from '@/components/DagDrilldown';
import { cn } from '@/lib/utils';

const VIEWS = [
  { key: 'dags', label: 'DAGs' },
  { key: 'findings', label: 'Findings' },
] as const;
type View = (typeof VIEWS)[number]['key'];

function Tile({
  label,
  value,
  delta,
  deltaLabel,
  upIsBad = true,
  children,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaLabel?: string;
  upIsBad?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="grid gap-1 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {delta !== undefined && (
          <p className={cn('text-xs tabular-nums', deltaClass(delta, upIsBad))}>
            {usdDelta(delta)} {deltaLabel}
          </p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function StateBadge({ state }: { state: SpendDagRow['state'] }) {
  return <Badge variant={STATE_VARIANT[state]}>{STATE_LABEL[state]}</Badge>;
}

export function SpendPanel() {
  const { role } = useAuth();
  const canOperate = role === 'operator' || role === 'admin';
  const queryClient = useQueryClient();
  const [{ sdag, stab, sview }, setUrl] = useUrlFilters({ sdag: '', stab: '', sview: '' }, [
    'sdag',
    'stab',
    'sview',
  ]);
  const view = oneOf(
    sview || 'dags',
    VIEWS.map((v) => v.key),
    'dags'
  ) as View;

  const summary = useQuery<SpendSummary>({
    queryKey: ['spend-summary'],
    queryFn: () => api.get('/api/spend/summary'),
    refetchInterval: 5 * 60_000,
    enabled: !sdag,
  });
  const dags = useQuery<SpendDagsResponse>({
    queryKey: ['spend-dags'],
    queryFn: () => api.get('/api/spend/dags'),
    refetchInterval: 5 * 60_000,
    enabled: !sdag,
  });
  const findings = useQuery<{ findings: SpendFinding[] }>({
    queryKey: ['spend-findings', 'open'],
    queryFn: () => api.get('/api/spend/findings?status=open'),
    enabled: !sdag && view === 'findings',
  });
  const ack = useMutation({
    mutationFn: (id: string) =>
      api.post<{ finding_id: string }>(`/api/spend/findings/${encodeURIComponent(id)}/ack`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['spend-findings'] });
      void queryClient.invalidateQueries({ queryKey: ['spend-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['spend-dags'] });
    },
  });

  if (sdag) {
    return (
      <DagDrilldown
        dagId={sdag}
        tab={stab}
        onTab={(next) => setUrl({ stab: next })}
        onBack={() => setUrl({ sdag: '', stab: '' })}
      />
    );
  }

  const t = summary.data?.tiles;
  const run = summary.data?.last_run;
  const stale = run ? Date.now() - new Date(run.run_at).getTime() > 3 * 3600_000 : false;
  const sorted = [...(dags.data?.dags ?? [])].sort((a, b) => b.usd_per_day_7d - a.usd_per_day_7d);
  const dagTotal7d = sorted.reduce((s, d) => s + d.usd_per_day_7d, 0);
  /* Dataform jobs whose invocation is not in invocation_index yet. Up to an hour's
     worth in steady state (the next tick indexes it); the whole Dataform SA while
     a backfill is still indexing. Shown as a note, never as a principal. */
  const unattributed = (dags.data?.principals ?? []).find((p) => p.dag_id === 'unattributed');
  const principals = (dags.data?.principals ?? []).filter((p) => p.dag_id !== 'unattributed');
  const principalTotal7d = principals.reduce((s, p) => s + p.usd_per_day_7d, 0);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pipeline Spend</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            BigQuery spend in sdfc-udp-dev by Airflow DAG, rolled up hourly from job metadata and
            priced at the us-west2 Analysis rate. Every DAG learns a 24-hour baseline; a schedule or
            tag change starts a new version that waits here for an admin to accept. Critical
            findings email the spend-critical list; everything else lands in the daily digest and on
            this page.
          </p>
        </div>
        {run && (
          <p className="text-xs text-muted-foreground">
            Last tick {relativeFrom(run.run_at)}
            {run.ok ? '' : ' (failed)'}
            {run.airflow_ok === false && ' · Airflow unreachable'}
          </p>
        )}
      </div>

      {summary.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load spend summary</AlertTitle>
          <AlertDescription>{(summary.error as Error).message}</AlertDescription>
        </Alert>
      )}
      {(stale || (run && !run.ok)) && (
        <Alert variant="destructive">
          <AlertTitle>
            {stale
              ? 'The spend monitor has not run for over three hours'
              : 'The last monitor tick failed'}
          </AlertTitle>
          <AlertDescription>
            {run?.error ?? 'Figures below are as of the last successful tick.'} Check the
            bq-spend-monitor job in Cloud Run.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {t ? (
          <>
            <Tile
              label="Today so far"
              value={usd(t.today_so_far, 2)}
              delta={t.today_so_far - t.expected_so_far}
              deltaLabel="against the same hours' baseline"
            />
            <Tile
              label="Month to date"
              value={usd(t.mtd)}
              delta={t.mtd - t.last_month_same_point}
              deltaLabel="against last month at this point"
            />
            <Tile
              label="Projected month"
              value={usd(t.projected_month)}
              delta={t.approved_per_day > 0 ? t.projected_month - t.approved_per_day * 30.4 : null}
              deltaLabel={
                t.approved_per_day > 0
                  ? `against ${usd(t.approved_per_day * 30.4)} approved`
                  : undefined
              }
            >
              <p className="text-xs text-muted-foreground">
                7-day average, {usd(t.yesterday, 2)} yesterday
              </p>
            </Tile>
            <Tile label="Open findings" value={String(t.open_findings)}>
              <p className="text-xs text-muted-foreground">
                {t.critical_findings} critical · {t.awaiting_acceptance} awaiting acceptance
              </p>
            </Tile>
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Last seven days by hour</CardTitle>
          <CardDescription>
            Actual spend divided by the same hour's four-week median. A regression shows as a band
            starting at the hour it began; the nightly Dataform spikes read as neutral.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summary.data ? (
            <HourHeatmap cells={summary.data.heatmap} />
          ) : (
            <Skeleton className="h-48" />
          )}
        </CardContent>
      </Card>

      <UnderlineTabs
        tabs={VIEWS}
        value={view}
        onChange={(v) => setUrl({ sview: v === 'dags' ? '' : v })}
      />

      {view === 'dags' && (
        <Card>
          <CardHeader>
            <CardTitle>DAGs</CardTitle>
            <CardDescription>
              Seven-day average per Pacific day against the accepted baseline. Click a row for
              tables, runs, the timeline and the accept action.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {dags.isError && (
              <Alert variant="destructive">
                <AlertDescription>{(dags.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {unattributed && unattributed.usd_per_day_7d > 0.01 && (
              <Alert>
                <AlertTitle>
                  {usd(unattributed.usd_per_day_7d, 2)}/day of Dataform spend is not attributed to a
                  DAG yet
                </AlertTitle>
                <AlertDescription>
                  Attribution lands on the tick after each run. A large figure means the monitor is
                  still indexing invocations (first run or a backfill); a small one is the last
                  hour.
                </AlertDescription>
              </Alert>
            )}
            {dags.data ? (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>DAG</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">$/day (7d)</TableHead>
                      <TableHead className="text-right">Baseline $/day</TableHead>
                      <TableHead className="text-right">Runs/day</TableHead>
                      <TableHead>Trend</TableHead>
                      <TableHead className="text-right">Projected month</TableHead>
                      <TableHead className="text-right">Findings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((d) => {
                      const delta =
                        d.baseline_usd_per_day != null
                          ? d.usd_per_day_7d - d.baseline_usd_per_day
                          : null;
                      return (
                        <TableRow
                          key={d.dag_id}
                          className="cursor-pointer"
                          onClick={() => setUrl({ sdag: d.dag_id, stab: '' })}
                        >
                          <TableCell>
                            <div className="font-medium">{d.dag_id}</div>
                            <div className="text-xs text-muted-foreground">
                              {d.tags.length ? d.tags.join(', ') : 'no Dataform tags'}
                              {d.is_paused && ' · paused'}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{d.schedule ?? '—'}</TableCell>
                          <TableCell>
                            <StateBadge state={d.state} />
                            {d.state === 'learning' && d.learning_until && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                until {formatPacific(d.learning_until, false)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(d.usd_per_day_7d, 2)}
                            {delta != null && (
                              <div className={cn('text-xs', deltaClass(delta))}>
                                {usdDelta(delta, 2)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(d.baseline_usd_per_day, 2)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.runs_per_day_7d.toFixed(d.runs_per_day_7d < 10 ? 1 : 0)}
                            {d.runs_per_day_expected != null && (
                              <div className="text-xs text-muted-foreground">
                                of {Math.round(d.runs_per_day_expected)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Sparkline
                              values={d.series.map((s) => s.usd)}
                              reference={d.baseline_usd_per_day}
                              title={`${d.dag_id}: ${d.series.map((s) => `${s.day_pt} ${usd(s.usd, 2)}`).join(', ')}`}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(d.projected_month)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.open_findings ? (
                              <Badge variant={d.critical_findings ? 'destructive' : 'warning'}>
                                {d.open_findings}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/40 font-medium">
                      <TableCell colSpan={3}>All DAGs</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(dagTotal7d, 2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(
                          sorted.reduce((s, d) => s + (d.baseline_usd_per_day ?? 0), 0),
                          2
                        )}
                      </TableCell>
                      <TableCell colSpan={2} />
                      <TableCell className="text-right tabular-nums">
                        {usd(dagTotal7d * 30.4)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Skeleton className="h-64" />
            )}
            {dags.data && principals.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Other principals (not Dataform): {usd(principalTotal7d, 2)}/day
                </summary>
                <div className="mt-2 overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Principal</TableHead>
                        <TableHead className="text-right">$/day (7d)</TableHead>
                        <TableHead>Trend</TableHead>
                        <TableHead className="text-right">Projected month</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {principals.map((p) => (
                        <TableRow key={p.dag_id}>
                          <TableCell className="font-mono text-xs">
                            {p.dag_id.replace(/^principal:/, '')}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(p.usd_per_day_7d, 2)}
                          </TableCell>
                          <TableCell>
                            <Sparkline values={p.series.map((s) => s.usd)} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(p.projected_month)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {view === 'findings' && (
        <Card>
          <CardHeader>
            <CardTitle>Open findings</CardTitle>
            <CardDescription>
              Critical rows have emailed the spend-critical list. Acknowledging stops repeat emails;
              schedule changes resolve only when an admin accepts the new baseline on the DAG.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {findings.isError && (
              <Alert variant="destructive">
                <AlertDescription>{(findings.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {ack.isError && (
              <Alert variant="destructive">
                <AlertDescription>{(ack.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {findings.data ? (
              findings.data.findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing open.</p>
              ) : (
                <FindingsTable
                  findings={findings.data.findings}
                  onDag={(id) => setUrl({ sdag: id, stab: '' })}
                  onAck={canOperate ? (id) => ack.mutate(id) : undefined}
                  acking={ack.isPending}
                />
              )
            ) : (
              <Skeleton className="h-40" />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function FindingsTable({
  findings,
  onDag,
  onAck,
  acking,
}: {
  findings: SpendFinding[];
  onDag?: (dagId: string) => void;
  onAck?: (id: string) => void;
  acking?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead>DAG / table</TableHead>
            <TableHead className="text-right">Δ per month</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead>Status</TableHead>
            {onAck && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((f) => (
            <TableRow key={f.finding_id}>
              <TableCell>
                <Badge variant={f.severity === 'critical' ? 'destructive' : 'outline'}>
                  {KIND_LABEL[f.kind] ?? f.kind}
                </Badge>
              </TableCell>
              <TableCell>
                {f.dag_id ? (
                  onDag ? (
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => onDag(f.dag_id!)}
                    >
                      {f.dag_id}
                    </button>
                  ) : (
                    <span className="font-medium">{f.dag_id}</span>
                  )
                ) : (
                  <span className="text-muted-foreground">project-wide</span>
                )}
                {f.table_key && (
                  <div className="font-mono text-xs text-muted-foreground">{f.table_key}</div>
                )}
              </TableCell>
              <TableCell
                className={cn('text-right tabular-nums', deltaClass(f.usd_per_month_delta))}
              >
                {usdDelta(f.usd_per_month_delta)}
              </TableCell>
              <TableCell className="max-w-md text-xs text-muted-foreground">{f.detail}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                {formatPacific(f.first_seen)}
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[f.status]}>{STATUS_LABEL[f.status]}</Badge>
                {f.acted_by && (
                  <div className="mt-1 text-xs text-muted-foreground">{f.acted_by}</div>
                )}
              </TableCell>
              {onAck && (
                <TableCell className="text-right">
                  {f.status === 'open' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={acking}
                      onClick={() => onAck(f.finding_id)}
                    >
                      Acknowledge
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
