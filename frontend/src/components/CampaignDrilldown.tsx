import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
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
  type CheckStatus,
  type HarnessRun,
  type HarnessRunSummary,
  type ShadowCandidate,
  type SlugEntry,
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
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UnderlineTabs } from '@/components/ui/underline-tabs';
import { AffectedCustomersTab } from '@/components/AffectedCustomers';
import { WouldFireTab } from '@/components/WouldFire';
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
import { mailpitInboxUrl, mailpitMessageUrl } from '@/lib/mailpit';
import SlugVariablesPanel from '@/components/SlugVariables';

/* Tabs follow the testing workflow left to right: is everything there →
   configure it → do the variables line up → full wiring check → fire and
   watch. */
export const CAMPAIGN_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'registration', label: 'Registration' },
  { key: 'variables', label: 'Variables' },
  { key: 'wiring', label: 'Wiring check' },
  { key: 'preview', label: 'Would fire' },
  { key: 'affected', label: 'Have fired' },
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
            {canEdit && entry?.runnable && (
              <Button disabled={runPending} onClick={() => onRun(slug)}>
                {runPending ? 'Starting…' : 'Run test'}
              </Button>
            )}
          </div>
          <CampaignFacts slug={slug} entry={entry} canEdit={canEdit} />
        </CardHeader>
      </Card>

      <UnderlineTabs tabs={CAMPAIGN_TABS} value={tab} onChange={onTab} />

      {tab === 'overview' && <OverviewTab slug={slug} onOpenWiring={() => onTab('wiring')} />}
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
      {tab === 'preview' && <WouldFireTab slug={slug} />}
      {tab === 'affected' && <AffectedCustomersTab slug={slug} />}
      {tab === 'runs' && (
        <>
          <ShadowPanel slug={slug} entry={entry} canEdit={canEdit} />
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
/* Header facts as a label/value table, with the free-text note broken out
   below it — the note is the one field an operator edits from here. */
function CampaignFacts({
  slug,
  entry,
  canEdit,
}: {
  slug: string;
  entry: SlugEntry | undefined;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /* Grow the field to its content so the editor matches the rendered note. */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  const save = useMutation({
    mutationFn: (notes: string) =>
      api.patch<SlugEntry>(`/api/slugs/${encodeURIComponent(slug)}/notes`, {
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['slugs'] });
    },
  });

  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Slug', value: <code className="text-xs">{slug}</code> },
    {
      label: 'Test event',
      value: entry?.test_event_name ? (
        <code className="text-xs">{entry.test_event_name}</code>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: 'Prod event',
      value: entry?.event_name ? (
        <code className="text-xs">{entry.event_name}</code>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: 'Last updated',
      value: entry?.updated_at ? (
        <>
          {formatPacific(entry.updated_at)}{' '}
          <span className="text-muted-foreground">({relativeFrom(entry.updated_at)})</span>
          {entry.updated_by ? (
            <span className="text-muted-foreground"> · {entry.updated_by}</span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
  ];

  return (
    <div className="mt-4 grid gap-4">
      <dl className="overflow-hidden rounded-lg border text-sm">
        {facts.map((f) => (
          <div
            key={f.label}
            className="grid gap-0.5 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[11rem_1fr] sm:gap-4"
          >
            <dt className="font-medium text-muted-foreground">{f.label}</dt>
            <dd className="break-all">{f.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Notes</h3>
          {canEdit && !editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(entry?.notes ?? '');
                setEditing(true);
              }}
            >
              {entry?.notes ? 'Edit notes' : 'Add notes'}
            </Button>
          )}
        </div>

        {editing ? (
          <div className="grid gap-2">
            {/* Full width and auto-grown so the editor occupies exactly the
                space the saved note will — no 400px well, no inner scrollbar. */}
            <Textarea
              ref={textareaRef}
              autoFocus
              rows={2}
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              className="max-w-none resize-none overflow-hidden text-sm"
              placeholder="What a teammate needs to know about this campaign — wiring, open questions, gotchas."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? 'Saving…' : 'Save notes'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={save.isPending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving as {user?.email ?? 'signed-in user'} · {draft.length}/2000
            </p>
            {save.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not save notes</AlertTitle>
                <AlertDescription>{(save.error as Error).message}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : entry?.notes ? (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{entry.notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No notes yet{canEdit ? ' — add what a teammate would need to know.' : '.'}
          </p>
        )}
      </div>
    </div>
  );
}

function OverviewTab({ slug, onOpenWiring }: { slug: string; onOpenWiring: () => void }) {
  const precheck = useQuery({
    queryKey: ['precheck', slug],
    queryFn: () => api.get<SlugPrecheck>(`/api/slugs/${encodeURIComponent(slug)}/precheck`),
  });
  // Same key as WiringTab — one fetch feeds both the verdict here and the
  // full table there.
  const validation = useQuery({
    queryKey: ['validate', slug],
    queryFn: () => api.get<ValidationReport>(`/api/harness/validate/${encodeURIComponent(slug)}`),
  });
  const report = precheck.data;
  const summary = validation.data?.summary;
  const verdict = summary
    ? summary.fail > 0
      ? `${summary.fail} check${summary.fail === 1 ? '' : 's'} failing${
          summary.warn > 0 ? ` · ${summary.warn} warning${summary.warn === 1 ? '' : 's'}` : ''
        }`
      : summary.warn > 0
        ? `Nothing failing · ${summary.warn} warning${summary.warn === 1 ? '' : 's'}`
        : 'All wiring checks pass'
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
        <CardDescription>
          Campaign presence at a glance and the payload the runner will send. Full findings live
          on the Wiring check tab; fix-it-in-one-click offers on the Registration tab's check.
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
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {validation.isPending && (
                <span className="text-muted-foreground">Running the wiring check…</span>
              )}
              {validation.isError && (
                <span className="text-muted-foreground">Wiring check unavailable.</span>
              )}
              {summary && verdict && (
                <>
                  <Badge
                    variant={
                      summary.fail > 0 ? 'destructive' : summary.warn > 0 ? 'secondary' : 'default'
                    }
                  >
                    {summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass'}
                  </Badge>
                  <span>{verdict}</span>
                </>
              )}
              <button
                type="button"
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={onOpenWiring}
              >
                Open the Wiring check
              </button>
            </div>
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
              disabled={precheck.isFetching || validation.isFetching}
              onClick={() => {
                void precheck.refetch();
                void validation.refetch();
              }}
            >
              {precheck.isFetching || validation.isFetching ? 'Checking…' : 'Re-check'}
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

/* Real-data ("shadow") runs: fire the test twin with sanitized REAL events —
   recipient rewritten to shadow.*@qa.sdfc.dev, every other address moved to
   the sink domain, profile-identity ids SHADOW- prefixed so no real fan's
   mail or CIO profile can be touched. */
function ShadowPanel({
  slug,
  entry,
  canEdit,
}: {
  slug: string;
  entry: SlugEntry | undefined;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirmReplay, setConfirmReplay] = useState(false);
  const [confirmArm, setConfirmArm] = useState(false);

  const preview = useQuery({
    queryKey: ['shadow-preview', slug],
    queryFn: () =>
      api.get<{ candidates: ShadowCandidate[]; already_run: number }>(
        `/api/harness/replay/${encodeURIComponent(slug)}/preview?limit=10&history_days=180`
      ),
    enabled: !!entry?.trigger_key,
  });

  const replay = useMutation({
    mutationFn: () =>
      api.post<{ fired: number }>(`/api/harness/replay/${encodeURIComponent(slug)}`, {
        limit: 10,
        history_days: 180,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['harness-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['shadow-preview', slug] });
    },
  });

  const arm = useMutation({
    mutationFn: (armed: boolean) =>
      api.post<SlugEntry>(`/api/slugs/${encodeURIComponent(slug)}/shadow`, { armed }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['slugs'] }),
  });

  if (!entry?.trigger_key) return null;
  const fireable = (preview.data?.candidates ?? []).filter((c) => !c.already_run);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Real-data shadow runs</CardTitle>
        <CardDescription>
          Fires the test twin with the real events the production trigger would fire on. The
          recipient becomes a shadow.*@qa.sdfc.dev sink address, every other email in the payload is
          rewritten to the sink domain, and profile ids get a SHADOW- prefix — no mail or profile
          write can reach a real fan. Each real event runs at most once.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {preview.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(preview.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {preview.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event date</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Real email</TableHead>
                <TableHead>Event key</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.data.candidates.map((c) => (
                <TableRow key={c.dedup_key}>
                  <TableCell className="text-sm whitespace-nowrap">
                    {c.event_at ? formatPacific(c.event_at) : '—'}
                  </TableCell>
                  <TableCell className="text-sm">
                    {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{c.email ?? '—'}</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{c.dedup_key}</code>
                  </TableCell>
                  <TableCell>
                    {c.already_run ? (
                      <Badge variant="outline">Already run</Badge>
                    ) : (
                      <Badge variant="secondary">New</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {replay.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(replay.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={replay.isPending || fireable.length === 0}
              onClick={() => setConfirmReplay(true)}
            >
              {replay.isPending
                ? 'Firing…'
                : `Replay ${fireable.length} real event${fireable.length === 1 ? '' : 's'}`}
            </Button>
            <Button
              variant={entry.shadow_armed ? 'secondary' : 'outline'}
              disabled={arm.isPending}
              aria-pressed={entry.shadow_armed}
              onClick={() => (entry.shadow_armed ? arm.mutate(false) : setConfirmArm(true))}
            >
              {entry.shadow_armed ? 'Auto-fire on new events: ON' : 'Auto-fire on new events: OFF'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Auto-fire checks for new qualifying events on the 10-minute tick, max 5 per tick.
            </span>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmReplay}
        onOpenChange={setConfirmReplay}
        title={`Fire ${fireable.length} shadow run${fireable.length === 1 ? '' : 's'}?`}
        description="Each selected real event fires the test twin once with its sanitized payload. All mail lands in the qa.sdfc.dev sink; real fans and their CIO profiles are untouched."
        confirmLabel="Fire replay"
        onConfirm={() => replay.mutate()}
      />
      <ConfirmDialog
        open={confirmArm}
        onOpenChange={setConfirmArm}
        title="Auto-fire shadow runs on new events?"
        description="Every new qualifying event will fire a sanitized shadow run within 10 minutes (max 5 per tick). Unattended failures email the alert recipients."
        confirmLabel="Arm auto-fire"
        onConfirm={() => arm.mutate(true)}
      />
    </Card>
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
          <span className="inline-flex items-center gap-1.5">
            <a
              href={mailpitInboxUrl(info.getValue())}
              target="_blank"
              rel="noreferrer"
              title={`${info.getValue()} — open in Mailpit`}
              onClick={(e) => e.stopPropagation()}
            >
              <code className="text-xs underline-offset-2 hover:underline">
                {shortIdentity(info.getValue())}
              </code>
            </a>
            {info.row.original.mode === 'shadow' && <Badge variant="outline">Shadow</Badge>}
          </span>
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

/* Failure details arrive as one prefixed string ("render/payload checks
   failed:" + one problem per line; legacy runs joined with '; '). Parsed here
   so repetitive problems render as an aligned table instead of a text blob. */
const RUN_PROBLEM_PREFIX: Record<string, string> = {
  'render/payload checks failed': 'Render / payload checks failed',
  'assertions failed': 'Assertions failed',
  'payload check': 'Payload check',
};

function parseRunProblems(detail: string): { heading: string; problems: string[] } | null {
  const m = detail.match(/^(render\/payload checks failed|assertions failed|payload check):\s*/);
  if (!m) return null;
  const rest = detail.slice(m[0].length);
  const problems = (rest.includes('\n') ? rest.split('\n') : rest.split('; '))
    .map((p) => p.trim())
    .filter(Boolean);
  return { heading: RUN_PROBLEM_PREFIX[m[1]] ?? m[1], problems };
}

const PROBLEM_FIELD_PATTERNS = [
  /payload field '([^']+)'/,
  /emails reference (\w+)/,
  /^(\w+)=\d+ \(<\d+\)/,
  /\{\{\s*(?:trigger|customer|event)\.(\w+)/,
];

function problemField(problem: string): string | null {
  for (const re of PROBLEM_FIELD_PATTERNS) {
    const m = problem.match(re);
    if (m) return m[1];
  }
  return null;
}

function RunProblems({ detail }: { detail: string }) {
  const parsed = parseRunProblems(detail);
  if (!parsed || parsed.problems.length < 2) {
    return <p className="text-sm whitespace-pre-line">{detail}</p>;
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">
        {parsed.heading} — {parsed.problems.length} problem{parsed.problems.length === 1 ? '' : 's'}
      </p>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Field</TableHead>
              <TableHead>Problem</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parsed.problems.map((p, i) => (
              <TableRow key={i}>
                <TableCell className="align-top font-mono text-xs">
                  {problemField(p) ?? '—'}
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{p}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* "delivery 1 'Subject' arrived <iso>; engaged {'opens_found': 1, ...}" */
function parseDelivery(
  detail: string,
): { n: string; subject: string; arrived: string; opens?: string; clicks?: string } | null {
  const m = detail.match(/^delivery (\d+) '(.+)' arrived ([^;]+); engaged \{(.+)\}$/);
  if (!m) return null;
  return {
    n: m[1],
    subject: m[2],
    arrived: m[3],
    opens: m[4].match(/'opens_found': (\d+)/)?.[1],
    clicks: m[4].match(/'clicks_found': (\d+)/)?.[1],
  };
}

/* "Delay profile: trigger → 'A': 69s; 'A' → 'B': 6m 00s (>5m). 1 block(s) exceed 5 min — …" */
function parseDelayProfile(
  detail: string,
): { legs: { from: string; to: string; delay: string }[]; note: string | null } | null {
  const m = detail.match(/^Delay profile: ([\s\S]+)$/);
  if (!m) return null;
  let body = m[1];
  let note: string | null = null;
  const noteM = body.match(/\.\s+(\d+ block\(s\) exceed[\s\S]+)$/);
  if (noteM) {
    note = noteM[1];
    body = body.slice(0, noteM.index);
  }
  body = body.replace(/\.\s*$/, '');
  const unquote = (s: string) => s.trim().replace(/^'(.*)'$/, '$1');
  const legs: { from: string; to: string; delay: string }[] = [];
  for (const seg of body.split('; ')) {
    const ci = seg.lastIndexOf(': ');
    const path = ci === -1 ? '' : seg.slice(0, ci);
    const ai = path.lastIndexOf(' → ');
    if (ci === -1 || ai === -1) return null;
    legs.push({ from: unquote(path.slice(0, ai)), to: unquote(path.slice(ai + 3)), delay: seg.slice(ci + 2) });
  }
  return legs.length > 0 ? { legs, note } : null;
}

/* Timeline details are stored as prose strings (BQ column); the known shapes
   are parsed back into structure here, anything unrecognized stays as text. */
function TimelineDetail({ detail }: { detail: string }) {
  const problems = parseRunProblems(detail);
  if (problems && problems.problems.length > 1) return <RunProblems detail={detail} />;

  const delivery = parseDelivery(detail);
  if (delivery) {
    return (
      <span>
        <span className="font-medium text-foreground">{delivery.subject}</span>
        <span className="block">
          Delivery {delivery.n} · arrived {formatPacific(delivery.arrived)}
          {delivery.opens !== undefined &&
            ` · ${delivery.opens} open${delivery.opens === '1' ? '' : 's'}`}
          {delivery.clicks !== undefined &&
            ` · ${delivery.clicks} click${delivery.clicks === '1' ? '' : 's'}`}
        </span>
      </span>
    );
  }

  const profile = parseDelayProfile(detail);
  if (profile) {
    return (
      <div className="grid gap-2">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="w-28">Delay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.legs.map((leg, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-normal">{leg.from}</TableCell>
                  <TableCell className="whitespace-normal">{leg.to}</TableCell>
                  <TableCell
                    className={cn('whitespace-nowrap', leg.delay.includes('(>5m)') && 'text-destructive')}
                  >
                    {leg.delay}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {profile.note && <span className="block">{profile.note}</span>}
      </div>
    );
  }

  return <>{detail}</>;
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
          <div className="flex items-center gap-2">
            {current && (
              <a
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                href={mailpitInboxUrl(current.identity)}
                target="_blank"
                rel="noreferrer"
              >
                Open in Mailpit ↗
              </a>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
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
            {current.detail && <RunProblems detail={current.detail} />}
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
                    <TableCell className="text-sm whitespace-pre-line text-muted-foreground">
                      <TimelineDetail detail={t.detail} />
                      {t.msg_id && (
                        <>
                          {' '}
                          <a
                            className="whitespace-nowrap underline underline-offset-2 hover:text-foreground"
                            href={mailpitMessageUrl(t.msg_id)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View email ↗
                          </a>
                        </>
                      )}
                    </TableCell>
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
