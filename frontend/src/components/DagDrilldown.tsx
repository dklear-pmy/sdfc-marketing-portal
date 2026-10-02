import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SpendDagDetail } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatPacific, relativeFrom } from '@/lib/format';
import { oneOf } from '@/lib/urlState';
import {
  deltaClass,
  gib,
  pct,
  shortSha,
  STATE_LABEL,
  STATE_VARIANT,
  usd,
  usdDelta,
} from '@/lib/spend';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { FindingsTable } from '@/components/SpendPanel';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const TABS = [
  { key: 'tables', label: 'Tables' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'runs', label: 'Runs' },
  { key: 'findings', label: 'Findings' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/* Daily columns for the last 28 Pacific days with version boundaries as hairlines.
   One series, thin marks, the latest day in the accent; values are in the hover
   title and in the Runs tab, so the chart never carries them alone. */
function DailyColumns({ detail }: { detail: SpendDagDetail }) {
  const days = new Map<string, number>();
  for (const h of detail.hourly) {
    const d = new Date(h.hour).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    days.set(d, (days.get(d) ?? 0) + h.usd);
  }
  const keys = [...days.keys()].sort();
  if (keys.length === 0)
    return <p className="text-sm text-muted-foreground">No spend in the last 28 days.</p>;
  const W = 720;
  const H = 140;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const max = Math.max(...keys.map((k) => days.get(k)!), 0.01);
  const bw = (W - pad.l - pad.r) / keys.length;
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const boundaries = detail.versions
    .filter((v) => v.change_reason !== 'new_dag')
    .map((v) =>
      new Date(v.valid_from).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    )
    .filter((d) => keys.includes(d));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Daily spend, last 28 days"
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(max * f)}
            y2={y(max * f)}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={pad.l - 6}
            y={y(max * f) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {usd(max * f, max < 10 ? 1 : 0)}
          </text>
        </g>
      ))}
      {keys.map((k, i) => {
        const v = days.get(k)!;
        const last = i === keys.length - 1;
        return (
          <g key={k}>
            <rect
              x={pad.l + i * bw + 1}
              y={y(v)}
              width={Math.max(bw - 2, 1)}
              height={Math.max(y(0) - y(v), 0)}
              rx={2}
              className={
                last
                  ? 'fill-sdfc-azul-bright dark:fill-[#3987e5]'
                  : 'fill-sdfc-chrome-medium dark:fill-sdfc-chrome'
              }
            >
              <title>{`${k}: ${usd(v, 2)}`}</title>
            </rect>
            {(i === 0 || i === keys.length - 1 || i % 7 === 0) && (
              <text
                x={pad.l + i * bw + bw / 2}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {k.slice(5)}
              </text>
            )}
          </g>
        );
      })}
      {boundaries.map((d) => {
        const i = keys.indexOf(d);
        return (
          <line
            key={d}
            x1={pad.l + i * bw}
            x2={pad.l + i * bw}
            y1={pad.t}
            y2={y(0)}
            className="stroke-amber-500"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          >
            <title>{`New baseline version from ${d}`}</title>
          </line>
        );
      })}
    </svg>
  );
}

export function DagDrilldown({
  dagId,
  tab,
  onTab,
  onBack,
}: {
  dagId: string;
  tab: string;
  onTab: (next: string) => void;
  onBack: () => void;
}) {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const active = oneOf(
    tab || 'tables',
    TABS.map((t) => t.key),
    'tables'
  ) as Tab;

  const detail = useQuery<SpendDagDetail>({
    queryKey: ['spend-dag', dagId],
    queryFn: () => api.get(`/api/spend/dags/${encodeURIComponent(dagId)}`),
  });
  const accept = useMutation({
    mutationFn: () =>
      api.post<{ version: number }>(
        `/api/spend/dags/${encodeURIComponent(dagId)}/baseline/accept`,
        {}
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['spend-dag', dagId] });
      void queryClient.invalidateQueries({ queryKey: ['spend-dags'] });
      void queryClient.invalidateQueries({ queryKey: ['spend-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['spend-findings'] });
    },
  });
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/spend/findings/${encodeURIComponent(id)}/ack`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['spend-dag', dagId] }),
  });

  const back = (
    <Button variant="outline" size="sm" onClick={onBack}>
      ← Back to DAGs
    </Button>
  );

  if (detail.isError) {
    return (
      <div className="grid gap-4">
        {back}
        <Alert variant="destructive">
          <AlertTitle>Could not load {dagId}</AlertTitle>
          <AlertDescription>{(detail.error as Error).message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="grid gap-4">
        {back}
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const d = detail.data;
  const cur = d.current_version;
  const prev = d.versions.find((v) => v.accepted_at && v.version !== cur?.version);
  const canAccept =
    role === 'admin' && d.dag.state === 'unreviewed_change' && cur?.status === 'armed';
  const openFindings = d.findings.filter((f) => f.status === 'open' || f.status === 'acknowledged');

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          {back}
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{d.dag.dag_id}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{d.dag.schedule ?? 'no schedule'}</span>
            {d.dag.is_paused && ' · paused'} · tags{' '}
            {d.dag.tags.length ? d.dag.tags.join(', ') : 'none'} · {d.dag.cloud_run_jobs.length}{' '}
            Cloud Run job{d.dag.cloud_run_jobs.length === 1 ? '' : 's'} · first seen{' '}
            {formatPacific(d.dag.first_seen)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATE_VARIANT[d.dag.state]}>{STATE_LABEL[d.dag.state]}</Badge>
          {canAccept && (
            <Button size="sm" onClick={() => setConfirmAccept(true)} disabled={accept.isPending}>
              Accept new baseline
            </Button>
          )}
        </div>
      </div>

      {accept.isError && (
        <Alert variant="destructive">
          <AlertDescription>{(accept.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={confirmAccept}
        onOpenChange={setConfirmAccept}
        title={`Accept baseline v${cur?.version ?? ''} for ${d.dag.dag_id}?`}
        description={`The approved rate for this DAG becomes ${usd(cur?.usd_per_day, 2)}/day${
          prev ? ` (was ${usd(prev.usd_per_day, 2)}/day)` : ''
        }. Open schedule-change findings resolve and the daily digest stops listing it.`}
        confirmLabel="Accept baseline"
        onConfirm={() => {
          setConfirmAccept(false);
          accept.mutate();
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-2 py-4">
          <CardContent className="grid gap-1 px-4">
            <p className="text-xs text-muted-foreground">
              Current baseline {cur ? `v${cur.version}` : ''}
            </p>
            <p className="text-2xl font-semibold">
              {cur?.status === 'learning' ? 'Learning' : usd(cur?.usd_per_day, 2)}
            </p>
            <p className="text-xs text-muted-foreground">
              {cur?.status === 'learning'
                ? `until ${cur.learning_until ? formatPacific(cur.learning_until) : '—'}`
                : cur
                  ? `${usd(cur.usd_per_run_p50, 3)}/run · ${cur.runs_per_day?.toFixed(1)} runs/day · ${cur.accepted_at ? `accepted by ${cur.accepted_by}` : 'awaiting acceptance'}`
                  : 'no version yet'}
            </p>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="grid gap-1 px-4">
            <p className="text-xs text-muted-foreground">
              Previous accepted {prev ? `v${prev.version}` : ''}
            </p>
            <p className="text-2xl font-semibold">{usd(prev?.usd_per_day, 2)}</p>
            {cur?.usd_per_day != null && prev?.usd_per_day != null && (
              <p
                className={cn(
                  'text-xs tabular-nums',
                  deltaClass(cur.usd_per_day - prev.usd_per_day)
                )}
              >
                {usdDelta((cur.usd_per_day - prev.usd_per_day) * 30.4)}/month (
                {pct(cur.usd_per_day / prev.usd_per_day)})
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="grid gap-1 px-4">
            <p className="text-xs text-muted-foreground">Expected cadence</p>
            <p className="text-2xl font-semibold">
              {cur?.runs_per_day_expected != null
                ? `${Math.round(cur.runs_per_day_expected)}/day`
                : '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              from the cron; {cur?.runs_observed ?? 0} runs in the learning window
            </p>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="grid gap-1 px-4">
            <p className="text-xs text-muted-foreground">Open findings</p>
            <p className="text-2xl font-semibold">{openFindings.length}</p>
            <p className="text-xs text-muted-foreground">
              {openFindings.filter((f) => f.severity === 'critical').length} critical
            </p>
          </CardContent>
        </Card>
      </div>

      <UnderlineTabs tabs={TABS} value={active} onChange={(t) => onTab(t === 'tables' ? '' : t)} />

      {active === 'tables' && (
        <Card>
          <CardHeader>
            <CardTitle>Destination tables, last seven days</CardTitle>
            <CardDescription>
              GiB per run is the median over runs; the ratio compares it with the current baseline
              version. Tables the baseline never saw are marked new.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Table</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    <TableHead className="text-right">GiB/run</TableHead>
                    <TableHead className="text-right">Baseline GiB/run</TableHead>
                    <TableHead className="text-right">$/day</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.tables.map((t) => (
                    <TableRow key={t.table_key}>
                      <TableCell className="font-mono text-xs">
                        {t.table_key}
                        {!t.in_baseline && cur?.status === 'armed' && (
                          <Badge variant="warning" className="ml-2">
                            new
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.action_type ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{t.runs}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {gib(t.gib_per_run_p50)}
                        {t.gib_ratio != null && Math.abs(t.gib_ratio - 1) > 0.25 && (
                          <div className={cn('text-xs', deltaClass(t.gib_ratio - 1))}>
                            {pct(t.gib_ratio)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {gib(t.baseline_gib_per_run)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(t.usd_per_day, 2)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {active === 'timeline' && (
        <Card>
          <CardHeader>
            <CardTitle>Daily spend, last 28 days</CardTitle>
            <CardDescription>
              Pacific days. Dashed amber lines mark the start of a new baseline version. Below, the
              analytics commits that were executing, by first appearance.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <DailyColumns detail={d} />
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium">Baseline versions</h3>
                <ul className="grid gap-1 text-xs">
                  {d.versions.map((v) => (
                    <li key={v.version} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">v{v.version}</span>
                      <span className="text-muted-foreground">{formatPacific(v.valid_from)}</span>
                      <span>{v.change_reason?.replace('_', ' ')}</span>
                      <span className="font-mono text-muted-foreground">{v.schedule}</span>
                      <span className="tabular-nums">
                        {v.usd_per_day != null ? `${usd(v.usd_per_day, 2)}/day` : v.status}
                      </span>
                      {v.accepted_by && (
                        <span className="text-muted-foreground">accepted by {v.accepted_by}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Analytics commits seen</h3>
                {d.compile_changes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No compile SHAs indexed yet.</p>
                ) : (
                  <ul className="grid gap-1 text-xs">
                    {d.compile_changes.map((c) => (
                      <li key={c.compile_sha} className="flex gap-2">
                        <a
                          className="font-mono underline-offset-2 hover:underline"
                          href={`https://github.com/PMY-Group/sdfc-analytics/commit/${c.compile_sha}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortSha(c.compile_sha)}
                        </a>
                        <span className="text-muted-foreground">
                          from {formatPacific(c.first_seen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {active === 'runs' && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Dataform invocations</CardTitle>
            <CardDescription>
              One row per tag invocation. Source xcom means the Airflow task's own record;
              dataform_api means attributed by tag alone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Tag</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">$</TableHead>
                    <TableHead className="text-right">GiB</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.runs.map((r) => (
                    <TableRow key={r.invocation_id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {r.started_at ? formatPacific(r.started_at) : '—'}
                        {r.started_at && (
                          <div className="text-muted-foreground">{relativeFrom(r.started_at)}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.tag ?? '—'}</TableCell>
                      <TableCell className="text-xs">{r.state ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(r.usd, 3)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {gib(r.bytes_billed / 2 ** 30)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{shortSha(r.compile_sha)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.source}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {active === 'findings' && (
        <Card>
          <CardHeader>
            <CardTitle>Findings for this DAG</CardTitle>
            <CardDescription>Last 60 days, all statuses.</CardDescription>
          </CardHeader>
          <CardContent>
            {d.findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <FindingsTable
                findings={d.findings}
                onAck={role === 'operator' || role === 'admin' ? (id) => ack.mutate(id) : undefined}
                acking={ack.isPending}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
