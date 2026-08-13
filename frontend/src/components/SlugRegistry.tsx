import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type HarnessRunSummary,
  type PrecheckLevel,
  type SampleResult,
  type SlugEntry,
  type SlugListResponse,
  type SlugPrecheck,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlFilters } from '@/lib/urlState';
import { humanizeSlug, prettyPayload, relativeFrom, statusLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const findingVariant: Record<PrecheckLevel, 'destructive' | 'secondary' | 'outline'> = {
  fail: 'destructive',
  warn: 'secondary',
  info: 'outline',
};

const roleLabel: Record<string, string> = {
  test_trigger: 'Test · Trigger [1/2]',
  test_journey: 'Test · Journey [2/2]',
  prod_trigger: 'Prod · Trigger [1/2]',
  prod_journey: 'Prod · Journey [2/2]',
};

const runVariant: Record<HarnessRunSummary['status'], 'default' | 'destructive' | 'secondary'> = {
  RUNNING: 'secondary',
  PASSED: 'default',
  FAILED: 'destructive',
  TIMED_OUT: 'destructive',
};

/* Form drafts keep list fields as raw text (one per line or comma-separated)
   so typing stays natural; parsing happens only on save/precheck.
   webhook_secrets / test_webhook_secret are legacy Secret Manager references —
   no longer edited here, but carried through saves so old entries keep
   working until their URL is filled in. */
export interface Draft {
  slug: string;
  display_name: string;
  trigger_key: string;
  trigger_label: string;
  event_name: string;
  test_event_name: string;
  payload_fields: string;
  person_attributes: string;
  filter_fields: string;
  webhook_secrets: string;
  test_webhook_secret: string;
  test_webhook_url: string;
  prod_webhook_url: string;
  payload_template: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  slug: '',
  display_name: '',
  trigger_key: '',
  trigger_label: '',
  event_name: '',
  test_event_name: '',
  payload_fields: '',
  person_attributes: '',
  filter_fields: '',
  webhook_secrets: '',
  test_webhook_secret: '',
  test_webhook_url: '',
  prod_webhook_url: '',
  payload_template: '',
  notes: '',
};

export function toDraft(e: SlugEntry): Draft {
  return {
    slug: e.slug,
    display_name: e.display_name ?? '',
    trigger_key: e.trigger_key ?? '',
    trigger_label: e.trigger_label ?? '',
    event_name: e.event_name ?? '',
    test_event_name: e.test_event_name ?? '',
    payload_fields: e.payload_fields.join('\n'),
    person_attributes: e.person_attributes.join('\n'),
    filter_fields: e.filter_fields.join('\n'),
    webhook_secrets: e.webhook_secrets.join(', '),
    test_webhook_secret: e.test_webhook_secret ?? '',
    test_webhook_url: e.test_webhook_url ?? '',
    prod_webhook_url: e.prod_webhook_url ?? '',
    /* Older entries were saved single-line; always present JSON legibly. */
    payload_template: e.payload_template ? prettyPayload(e.payload_template) : '',
    notes: e.notes ?? '',
  };
}

const parseList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function toBody(d: Draft) {
  return {
    display_name: d.display_name.trim() || null,
    trigger_key: d.trigger_key.trim() || null,
    trigger_label: d.trigger_label.trim() || null,
    event_name: d.event_name.trim() || null,
    test_event_name: d.test_event_name.trim() || null,
    payload_fields: parseList(d.payload_fields),
    person_attributes: parseList(d.person_attributes),
    filter_fields: parseList(d.filter_fields),
    webhook_secrets: parseList(d.webhook_secrets),
    test_webhook_secret: d.test_webhook_secret.trim() || null,
    test_webhook_url: d.test_webhook_url.trim() || null,
    prod_webhook_url: d.prod_webhook_url.trim() || null,
    payload_template: d.payload_template.trim() || null,
    notes: d.notes.trim() || null,
  };
}

export default function SlugRegistry({
  selected,
  onSelect,
}: {
  selected?: string | null;
  onSelect: (slug: string) => void;
}) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const [{ rq }, setUrl] = useUrlFilters({ rq: '' });
  /* Whether the register form is open — transient UI, not in the URL.
     Editing an existing entry lives in the campaign drilldown, not here. */
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const listQuery = useQuery({
    queryKey: ['slugs'],
    queryFn: () => api.get<SlugListResponse>('/api/slugs'),
  });
  /* Shared cache with the drilldown's run views — the health column is free. */
  const runsQuery = useQuery({
    queryKey: ['harness-runs'],
    queryFn: () => api.get<{ runs: HarnessRunSummary[] }>('/api/harness/runs?limit=200'),
  });
  const lastRun = (slug: string) => runsQuery.data?.runs.find((r) => r.slug === slug);

  const entries = (listQuery.data?.slugs ?? []).filter(
    (e) =>
      !rq ||
      e.slug.toLowerCase().includes(rq.toLowerCase()) ||
      humanizeSlug(e.slug).toLowerCase().includes(rq.toLowerCase()) ||
      (e.display_name ?? '').toLowerCase().includes(rq.toLowerCase())
  );

  function openAdd() {
    /* Seed the slug from the search box — searching for a campaign that isn't
       registered yet is the natural first step of registering it. */
    setDraft({ ...EMPTY_DRAFT, slug: rq.trim() });
    setAdding(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registered campaigns</CardTitle>
        <CardDescription>
          Campaigns the tester knows how to validate and run. Click one to open it — overview,
          registration, variables, wiring check and test runs. To register one, enter its slug and
          check against Customer.io — the check fills in everything discoverable from the workspace
          and tells you what's missing before you save.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="max-w-xs"
            placeholder="Search campaigns…"
            value={rq}
            onChange={(e) => setUrl({ rq: e.target.value })}
          />
          {canEdit && !adding && (
            <Button variant="outline" onClick={openAdd}>
              Register campaign
            </Button>
          )}
          {rq.trim() && !listQuery.isPending && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Showing {entries.length} of {listQuery.data?.slugs.length ?? 0} registered
              <Button variant="outline" size="xs" onClick={() => setUrl({ rq: '' })}>
                Clear search
              </Button>
            </span>
          )}
        </div>

        {listQuery.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load the registry</AlertTitle>
            <AlertDescription>{(listQuery.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {!listQuery.isPending && entries.length === 0 && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>{rq ? 'No registered campaign matches.' : 'No campaigns registered yet.'}</span>
            {rq.trim() && canEdit && !adding && (
              <Button size="sm" variant="outline" onClick={openAdd}>
                Register “{rq.trim()}”
              </Button>
            )}
          </div>
        )}

        {entries.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Runner</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow
                  key={e.slug}
                  onClick={() => onSelect(e.slug)}
                  className={cn('cursor-pointer', e.slug === selected && 'bg-accent/50')}
                >
                  <TableCell>
                    <span className="font-medium whitespace-nowrap">
                      {e.display_name || humanizeSlug(e.slug)}
                    </span>
                    <code className="block text-xs text-muted-foreground">{e.slug}</code>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="grid grid-cols-[3rem_1fr] gap-x-1.5 gap-y-0.5">
                      <span className="text-right font-sans font-medium text-muted-foreground">
                        TEST:
                      </span>
                      <span className="whitespace-nowrap">{e.test_event_name ?? '—'}</span>
                      <span className="text-right font-sans font-medium text-muted-foreground">
                        PROD:
                      </span>
                      <span className="whitespace-nowrap">{e.event_name ?? '—'}</span>
                      <span className="text-right font-sans font-medium text-muted-foreground">
                        TRIG:
                      </span>
                      <span className="whitespace-nowrap">{e.trigger_key ?? '—'}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.runnable ? 'default' : 'secondary'}>
                      {e.runnable ? 'Runnable' : 'Not runnable'}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {(() => {
                      const r = lastRun(e.slug);
                      if (!r) return <span className="text-sm text-muted-foreground">—</span>;
                      return (
                        <span className="grid justify-items-start gap-0.5">
                          <Badge variant={runVariant[r.status]}>{statusLabel[r.status]}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {relativeFrom(r.started_at)}
                          </span>
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                    {e.updated_at ? relativeFrom(e.updated_at) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {adding && (
          <SlugForm
            existingSlug={null}
            draft={draft}
            setDraft={setDraft}
            defaultTemplate={listQuery.data?.default_payload_template ?? ''}
            tokens={listQuery.data?.payload_tokens ?? {}}
            onClose={() => setAdding(false)}
            onCommitted={() => {
              setAdding(false);
              /* The search that seeded this registration would otherwise keep
                 filtering the list to just the new entry — which reads as the
                 registry having lost everything else. */
              setUrl({ rq: '' });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function SlugForm({
  existingSlug,
  draft,
  setDraft,
  defaultTemplate,
  tokens,
  onClose,
  onCommitted,
}: {
  existingSlug: string | null;
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  defaultTemplate: string;
  tokens: Record<string, string>;
  onClose: () => void;
  /* After a save or delete lands — unlike onClose (cancel), the parent also
     clears the list search, so the full registry is visible again. */
  onCommitted: () => void;
}) {
  const queryClient = useQueryClient();
  const [filled, setFilled] = useState(0);
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmProdSample, setConfirmProdSample] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const precheck = useMutation({
    mutationFn: (d: Draft) => {
      const qs = new URLSearchParams();
      if (d.event_name.trim()) qs.set('event_name', d.event_name.trim());
      if (d.test_event_name.trim()) qs.set('test_event_name', d.test_event_name.trim());
      if (d.test_webhook_url.trim()) qs.set('test_webhook_url', d.test_webhook_url.trim());
      if (d.payload_template.trim()) qs.set('payload_template', d.payload_template.trim());
      const suffix = qs.size ? `?${qs}` : '';
      return api.get<SlugPrecheck>(
        `/api/slugs/${encodeURIComponent(d.slug.trim())}/precheck${suffix}`
      );
    },
    onSuccess: (report) => {
      /* Fill what Customer.io already knows into fields the user hasn't
         typed — never clobber anything non-empty. */
      const s = report.suggested ?? {};
      const patch: Partial<Draft> = {};
      if (s.event_name && !draft.event_name.trim()) patch.event_name = s.event_name;
      if (s.test_event_name && !draft.test_event_name.trim())
        patch.test_event_name = s.test_event_name;
      if (s.payload_fields?.length && !draft.payload_fields.trim())
        patch.payload_fields = s.payload_fields.join('\n');
      if (s.person_attributes?.length && !draft.person_attributes.trim())
        patch.person_attributes = s.person_attributes.join('\n');
      if (Object.keys(patch).length) setDraft((prev) => ({ ...prev, ...patch }));
      setFilled(Object.keys(patch).length);
    },
  });

  /* Opening the form with a slug already known — an existing entry, or a new
     one seeded from the search box — runs the check straight away, so the
     discoverable fields arrive without another click. */
  const precheckMutate = precheck.mutate;
  useEffect(() => {
    if (draft.slug.trim()) precheckMutate(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on-open only
  }, []);

  const save = useMutation({
    mutationFn: (d: Draft) => {
      /* Notes are edited in the drilldown header, not this form — send the
         freshest saved note so this form's opening-time snapshot can't
         clobber a newer edit. Falls back to the draft for new entries. */
      const cached = queryClient
        .getQueryData<SlugListResponse>(['slugs'])
        ?.slugs.find((s) => s.slug === (existingSlug ?? d.slug.trim()));
      const body = toBody(d);
      if (cached) body.notes = cached.notes;
      return api.put<SlugEntry>(`/api/slugs/${encodeURIComponent(d.slug.trim())}`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slugs'] });
      onCommitted();
    },
  });

  const remove = useMutation({
    mutationFn: (slug: string) =>
      api.del<{ deleted: string }>(`/api/slugs/${encodeURIComponent(slug)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slugs'] });
      onCommitted();
    },
  });

  /* Fires one contract-shaped payload at the SAVED entry's webhook. Uses the
     saved URL, not the draft: save first. The server decides the prod mode
     from the [1/2] trigger's LIVE state: draft/stopped seeds the composer's
     Trigger data sample; RUNNING executes the actions for real (flow-through
     check) — the server then requires an owned recipient and verifies
     nothing running listens on the prod event. force is the legacy override
     offered after a refusal. */
  const sample = useMutation({
    mutationFn: ({
      target,
      force,
      recipient,
    }: {
      target: 'test' | 'prod';
      force?: boolean;
      recipient?: string;
    }) =>
      api.post<SampleResult>(
        `/api/slugs/${encodeURIComponent(existingSlug ?? draft.slug.trim())}/sample` +
          `?target=${target}${force ? '&force=true' : ''}` +
          (recipient ? `&recipient=${encodeURIComponent(recipient)}` : '')
      ),
  });
  /* Owned recipient for a flow-through prod send (RUNNING [1/2] trigger). */
  const [prodRecipient, setProdRecipient] = useState('');

  /* The prod trigger's live state from the on-open precheck — dialog copy
     only; the server re-verifies at send time. */
  const prodState = precheck.data?.campaigns.find((c) => c.role === 'prod_trigger')?.state;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (draft.slug.trim()) save.mutate(draft);
  }

  const report = precheck.data;

  return (
    <form onSubmit={onSubmit} className="grid gap-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {existingSlug ? `Edit ${humanizeSlug(existingSlug)}` : 'Register a campaign'}
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="reg-slug">Campaign slug</Label>
          <Input
            id="reg-slug"
            required
            disabled={!!existingSlug}
            placeholder="e.g. Welcome-Retail-Shopify-260715"
            value={draft.slug}
            onChange={(e) => set({ slug: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-display-name">Display name</Label>
          <Input
            id="reg-display-name"
            placeholder="e.g. STM New Member Welcome Journey 260807"
            value={draft.display_name}
            onChange={(e) => set({ display_name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            What the portal shows everywhere for this campaign — rename freely; the slug stays the
            stable key. Blank falls back to the slug with hyphens as spaces.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-trigger-key">Trigger key (trigger hub)</Label>
          <Input
            id="reg-trigger-key"
            placeholder="e.g. tb_signup"
            value={draft.trigger_key}
            onChange={(e) => set({ trigger_key: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The triggers.py key of the production trigger that feeds this campaign — hub identity,
            deliberately not the campaign's name. It stays stable when a campaign pair is recreated
            under a new slug.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-trigger-label">Trigger display name</Label>
          <Input
            id="reg-trigger-label"
            placeholder="what the portal shows instead of the key — rename freely"
            value={draft.trigger_label}
            onChange={(e) => set({ trigger_label: e.target.value })}
          />
        </div>
        {/* Test on the left, prod on the right — same fields on both sides so
            the pair reads symmetrically; the tester drives the test half, the
            prod half is reference. */}
        <div className="grid content-start gap-3 rounded-lg border p-3">
          <div>
            <h4 className="text-sm font-medium">Test pair</h4>
            <p className="text-xs text-muted-foreground">
              The [PMY-TEST] twin campaigns — test runs fire this half.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reg-test-event">Trigger event (pmy_test_…)</Label>
            <Input
              id="reg-test-event"
              placeholder="pmy_test_…"
              value={draft.test_event_name}
              onChange={(e) => set({ test_event_name: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reg-test-url">Webhook URL</Label>
            <div className="flex items-center gap-2">
              <Input
                id="reg-test-url"
                className="max-w-full font-mono text-xs"
                placeholder="https://api.customer.io/v1/webhook/…"
                value={draft.test_webhook_url}
                onChange={(e) => set({ test_webhook_url: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={!draft.test_webhook_url.trim() || sample.isPending}
                onClick={() => sample.mutate({ target: 'test' })}
              >
                Send sample
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste it from the twin's [1/2] trigger settings — Customer.io doesn't expose webhook
              URLs via API. Required before the runner can fire this campaign; visible to signed-in
              portal users (internal tool, by design). The two URL fields look identical but must
              never be crossed: this one receives test fires, the prod one receives real hub rows.
              Identical values are refused on save.
            </p>
          </div>
        </div>
        <div className="grid content-start gap-3 rounded-lg border p-3">
          <div>
            <h4 className="text-sm font-medium">Prod pair</h4>
            <p className="text-xs text-muted-foreground">
              The live campaigns — reference only; the runner never fires this half.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reg-event">Trigger event</Label>
            <Input
              id="reg-event"
              placeholder="event the live journey listens on"
              value={draft.event_name}
              onChange={(e) => set({ event_name: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reg-prod-url">Webhook URL</Label>
            <div className="flex items-center gap-2">
              <Input
                id="reg-prod-url"
                className="max-w-full font-mono text-xs"
                placeholder="https://api.customer.io/v1/webhook/…"
                value={draft.prod_webhook_url}
                onChange={(e) => set({ prod_webhook_url: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={!draft.prod_webhook_url.trim() || sample.isPending}
                onClick={() => setConfirmProdSample(true)}
              >
                Send sample
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The live [1/2] campaign's inbound webhook — used only for composer sample payloads
              (Send sample seeds the Trigger data panel so trigger.* references validate). The
              trigger hub keeps its own copy in Secret Manager. Send sample uses the saved URL, so
              save the entry first.
            </p>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-payload">Payload fields (one per line)</Label>
          <Textarea
            id="reg-payload"
            rows={5}
            value={draft.payload_fields}
            onChange={(e) => set({ payload_fields: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-person">Person attributes (one per line)</Label>
          <Textarea
            id="reg-person"
            rows={5}
            value={draft.person_attributes}
            onChange={(e) => set({ person_attributes: e.target.value })}
          />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="reg-filters">Journey filter fields (one per line)</Label>
          <Textarea
            id="reg-filters"
            rows={3}
            value={draft.filter_fields}
            onChange={(e) => set({ filter_fields: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Payload fields the journey's entry-filter conditions read to decide who enters.
            Customer.io does not expose filter conditions via API, so keep this in step with the
            journey's trigger filters by hand — the Variables tab shows it as the "Journey
            filtering" column.
          </p>
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="reg-payload-template">Payload template (JSON, optional)</Label>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!defaultTemplate}
              onClick={() => {
                if (!draft.payload_template.trim()) set({ payload_template: defaultTemplate });
                else setConfirmTemplate(true);
              }}
            >
              Use signup default
            </Button>
          </div>
          <Textarea
            id="reg-payload-template"
            rows={8}
            className="max-w-full font-mono text-xs"
            placeholder='{"email": "{identity}", …}'
            value={draft.payload_template}
            onChange={(e) => set({ payload_template: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            What the runner POSTs to the twin's webhook. Leave empty for the signup shape (right for
            Welcome-General). For other journeys, mirror the fields the production trigger hub sends
            so runs exercise the real input shape — the check below compares it against how the
            campaigns resolve people. Tokens fill in at fire time:{' '}
            {Object.entries(tokens).map(([tok, doc], i) => (
              <span key={tok}>
                {i > 0 && ' · '}
                <code title={doc}>{tok}</code>
              </span>
            ))}
            .
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!draft.slug.trim() || precheck.isPending}
          onClick={() => precheck.mutate(draft)}
        >
          {precheck.isPending ? 'Checking…' : 'Check against Customer.io'}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : existingSlug ? 'Save changes' : 'Register'}
        </Button>
        {existingSlug && (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmTemplate}
        onOpenChange={setConfirmTemplate}
        title="Replace the payload template?"
        description="The current template is overwritten with the signup default. Nothing is saved until you save the entry."
        confirmLabel="Replace"
        onConfirm={() => set({ payload_template: defaultTemplate })}
      />
      {existingSlug && (
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${humanizeSlug(existingSlug)} from the registry?`}
          description="The Customer.io campaigns are not touched — only the tester forgets this campaign."
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutate(existingSlug)}
        />
      )}
      <ConfirmDialog
        open={confirmProdSample}
        onOpenChange={setConfirmProdSample}
        destructive={prodState === 'running'}
        title={
          prodState === 'running'
            ? 'Send a flow-through sample to the PROD webhook?'
            : 'Send a sample payload to the PROD webhook?'
        }
        description={
          prodState === 'running' ? (
            <span className="grid gap-3">
              <span>
                The prod [1/2] trigger is RUNNING: this send executes Create or Update Person and
                fires the prod event for the recipient below — the values land on that person in the
                production workspace. The server verifies first that nothing running listens on the
                prod event, so with the journey off it stops there.
              </span>
              <Input
                placeholder="Owned recipient — @pmygroup.com or @sdfc.dev"
                value={prodRecipient}
                onChange={(e) => setProdRecipient(e.target.value)}
              />
              <span>Never a fan address — the server refuses anything not on an owned domain.</span>
            </span>
          ) : prodState && ['draft', 'stopped', 'paused'].includes(prodState) ? (
            `The prod campaign is currently ${prodState} — Customer.io stores the payload as Trigger data and runs nothing. The server re-checks the live state before sending.`
          ) : prodState ? (
            `The prod campaign is currently ${prodState.toUpperCase()} — the sample identity (scenario-000@qa.sdfc.dev) would enter the live workflow, so the server will refuse this send unless forced.`
          ) : (
            'The prod campaign state could not be read — the server checks it live and only sends while the campaign is draft or stopped.'
          )
        }
        confirmLabel={prodState === 'running' ? 'Send flow-through sample' : 'Send sample'}
        onConfirm={() =>
          sample.mutate({ target: 'prod', recipient: prodRecipient.trim() || undefined })
        }
      />

      {sample.isError && (
        <Alert variant="destructive">
          <AlertTitle>Sample not sent</AlertTitle>
          <AlertDescription>{(sample.error as Error).message}</AlertDescription>
          {(sample.error as Error).message.includes('force') && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-fit"
              disabled={sample.isPending}
              onClick={() => sample.mutate({ target: 'prod', force: true })}
            >
              Send anyway — I understand it enters the live workflow
            </Button>
          )}
        </Alert>
      )}
      {sample.isSuccess && (
        <Alert>
          <AlertTitle>
            {sample.data.mode === 'flow_through'
              ? `Flow-through sample delivered to the prod webhook (HTTP ${sample.data.status_code})`
              : `Sample delivered to the ${sample.data.target} webhook (HTTP ${sample.data.status_code})`}
          </AlertTitle>
          <AlertDescription>
            {sample.data.mode === 'flow_through' ? (
              <>
                Create or Update Person ran and the prod event fired for {sample.data.identity} —
                nothing running was listening, so it stops there.{' '}
                {sample.data.person_url ? (
                  <a
                    href={sample.data.person_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    Open the person in Customer.io ↗
                  </a>
                ) : (
                  <>
                    Search {sample.data.identity} under People in Customer.io to inspect the values
                    that came through.
                  </>
                )}
              </>
            ) : (
              <>
                Re-open the campaign's composer and pick the newest sample — trigger.* references
                now validate against the contract payload for {sample.data.identity}.
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {(save.isError || remove.isError) && (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{((save.error ?? remove.error) as Error).message}</AlertDescription>
        </Alert>
      )}
      {precheck.isError && (
        <Alert variant="destructive">
          <AlertTitle>Check failed</AlertTitle>
          <AlertDescription>{(precheck.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {report && (
        <div className="grid gap-3 rounded-lg border bg-background p-3">
          <p className="text-sm font-medium">
            Customer.io check — {report.campaigns.length} of 4 campaigns found
            {report.registered ? '' : ' · slug not registered yet'}
          </p>
          {filled > 0 && (
            <p className="text-sm text-muted-foreground">
              {filled} empty field{filled > 1 ? 's were' : ' was'} filled from Customer.io — review
              before saving. Trigger key and webhook secrets are ours, not Customer.io's, so they
              stay manual.
            </p>
          )}
          {report.campaigns.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {report.campaigns.map((c) => (
                <span
                  key={c.role}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                  title={c.name}
                >
                  {roleLabel[c.role] ?? c.role} · #{c.id}
                  <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>{c.state}</Badge>
                </span>
              ))}
            </div>
          )}
          {report.payload_preview && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">
                Payload the runner will send —{' '}
                {report.payload_is_custom ? 'this slug’s template' : 'signup default'}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
                {JSON.stringify(report.payload_preview, null, 2)}
              </pre>
            </details>
          )}
          {report.findings.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Level</TableHead>
                    <TableHead className="w-16">Side</TableHead>
                    <TableHead className="w-[42%]">Finding</TableHead>
                    {report.findings.some((f) => f.fix) && (
                      <TableHead className="w-[42%]">Fix</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.findings.map((f, i) => (
                    <TableRow key={i}>
                      <TableCell className="align-top">
                        <Badge variant={findingVariant[f.level]}>{f.level}</Badge>
                      </TableCell>
                      <TableCell className="align-top">
                        {f.side ? (
                          <Badge variant="outline">{f.side === 'test' ? 'Test' : 'Prod'}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal text-muted-foreground">
                        {f.message}
                      </TableCell>
                      {report.findings.some((x) => x.fix) && (
                        <TableCell className="align-top">
                          {f.fix && (
                            <button
                              type="button"
                              className="text-left text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              onClick={() => {
                                /* Apply into the draft and re-check; Save persists it
                                   through the normal validated path. */
                                const next = { ...draft, [f.fix!.field]: f.fix!.value };
                                setDraft(next);
                                precheck.mutate(next);
                              }}
                            >
                              {f.fix.label}
                            </button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
