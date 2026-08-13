import { useState, type FormEvent } from 'react';
import { oneOf, useUrlFilters } from '@/lib/urlState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type HarnessRun, type HarnessRunSummary, type ValidationReport } from '@/lib/api';
import { humanizeSlug } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import SlugRegistry from '@/components/SlugRegistry';
import TriggersPanel from '@/components/TriggersPanel';
import CampaignDrilldown, {
  CAMPAIGN_TAB_KEYS,
  ValidationReportView,
  type CampaignTab,
} from '@/components/CampaignDrilldown';

export default function Harness() {
  /* The selected campaign, its tab and the open run are the shareable bits —
     "look at this failing run" is the whole point of a link here. A link that
     names only a run resolves its campaign from the runs feed and lands on
     that campaign's Test runs tab. */
  const [url, setUrl] = useUrlFilters({ sel: '', ctab: '', run: '', slug: '', rtab: '' }, [
    'sel',
    'ctab',
    'run',
    'rtab',
  ]);
  const queryClient = useQueryClient();
  /* Which list the page shows when no campaign is selected: the registered
     campaigns or the warehouse triggers that feed them. */
  const listTab = url.rtab === 'triggers' ? 'triggers' : 'campaigns';

  const runsQuery = useQuery({
    queryKey: ['harness-runs'],
    queryFn: () => api.get<{ runs: HarnessRunSummary[] }>('/api/harness/runs?limit=200'),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'RUNNING') ? 30_000 : false,
  });
  const runSlug = url.run
    ? runsQuery.data?.runs.find((r) => r.run_id === url.run)?.slug
    : undefined;
  const sel = url.sel || runSlug || '';
  const tab = oneOf<CampaignTab>(
    url.ctab || (url.run ? 'runs' : 'overview'),
    CAMPAIGN_TAB_KEYS,
    'overview'
  );

  const startRun = useMutation({
    mutationFn: (s: string) => api.post<HarnessRun>(`/api/harness/run/${encodeURIComponent(s)}`),
    onSuccess: (run) => {
      /* Land on the campaign's Test runs tab to watch what was just fired. */
      setUrl({ sel: run.slug, run: run.run_id, ctab: 'runs' });
      void queryClient.invalidateQueries({ queryKey: ['harness-runs'] });
    },
  });

  /* The slug awaiting run confirmation — the dialog is open while set. */
  const [confirmRun, setConfirmRun] = useState<string | null>(null);

  return (
    <div className="grid gap-6">
      {/* The page heading only frames the list — inside a drilldown the
          campaign name IS the heading. */}
      {!sel && (
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Campaign Tester</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prove a campaign works before any fan sees it — check its setup, then send a real
            end-to-end test to a safe test inbox.
          </p>
        </div>
      )}

      {startRun.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not start run</AlertTitle>
          <AlertDescription>{(startRun.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={!!confirmRun}
        onOpenChange={(o) => {
          if (!o) setConfirmRun(null);
        }}
        title={`Start an end-to-end test of ${confirmRun ? humanizeSlug(confirmRun) : ''}?`}
        description="It mints a fresh test identity, sends the twin campaign's real emails to the test inbox, and follows delivery, opens and clicks — no real fans involved. First results land in about 15 minutes; several runs can be in flight at once."
        confirmLabel="Start test"
        onConfirm={() => {
          if (confirmRun) startRun.mutate(confirmRun);
        }}
      />

      {sel ? (
        <CampaignDrilldown
          key={sel}
          slug={sel}
          tab={tab}
          onTab={(t) => setUrl({ ctab: t })}
          activeRunId={url.run || null}
          onSelectRun={(id) => setUrl({ run: id ?? '' })}
          onBack={() => setUrl({ sel: '', ctab: '', run: '' })}
          onRun={setConfirmRun}
          runPending={startRun.isPending}
        />
      ) : (
        <>
          <Tabs
            value={listTab}
            onValueChange={(v) => setUrl({ rtab: v === 'triggers' ? 'triggers' : '' })}
          >
            <TabsList>
              <TabsTrigger value="triggers">Triggers</TabsTrigger>
              <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            </TabsList>
          </Tabs>
          {listTab === 'campaigns' ? (
            <>
              <SlugRegistry onSelect={(s) => setUrl({ sel: s, ctab: '', run: '' })} />
              <FreeformValidate />
            </>
          ) : (
            <TriggersPanel onSelect={(s) => setUrl({ sel: s, ctab: '', run: '', rtab: '' })} />
          )}
        </>
      )}
    </div>
  );
}

/* Validate a campaign that isn't registered yet — registered ones validate
   from their drilldown's Wiring check tab. */
function FreeformValidate() {
  const [{ slug }, setUrl] = useUrlFilters({ slug: '' });
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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Validate an unregistered campaign</CardTitle>
          <CardDescription>
            Registered campaigns validate from their drilldown above. For anything else, enter the
            campaign's name code as it appears in Customer.io, e.g.{' '}
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
                onChange={(e) => setUrl({ slug: e.target.value })}
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

      {validation.data && <ValidationReportView report={validation.data} />}
    </>
  );
}
