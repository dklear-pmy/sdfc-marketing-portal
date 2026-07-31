import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type PrecheckLevel,
  type SlugEntry,
  type SlugListResponse,
  type SlugPrecheck,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlFilters } from '@/lib/urlState';
import { humanizeSlug, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
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

/* Form drafts keep list fields as raw text (one per line or comma-separated)
   so typing stays natural; parsing happens only on save/precheck.
   webhook_secrets / test_webhook_secret are legacy Secret Manager references —
   no longer edited here, but carried through saves so old entries keep
   working until their URL is filled in. */
interface Draft {
  slug: string;
  trigger_key: string;
  event_name: string;
  test_event_name: string;
  payload_fields: string;
  person_attributes: string;
  webhook_secrets: string;
  test_webhook_secret: string;
  test_webhook_url: string;
  payload_template: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  slug: '',
  trigger_key: '',
  event_name: '',
  test_event_name: '',
  payload_fields: '',
  person_attributes: '',
  webhook_secrets: '',
  test_webhook_secret: '',
  test_webhook_url: '',
  payload_template: '',
  notes: '',
};

function toDraft(e: SlugEntry): Draft {
  return {
    slug: e.slug,
    trigger_key: e.trigger_key ?? '',
    event_name: e.event_name ?? '',
    test_event_name: e.test_event_name ?? '',
    payload_fields: e.payload_fields.join('\n'),
    person_attributes: e.person_attributes.join('\n'),
    webhook_secrets: e.webhook_secrets.join(', '),
    test_webhook_secret: e.test_webhook_secret ?? '',
    test_webhook_url: e.test_webhook_url ?? '',
    payload_template: e.payload_template ?? '',
    notes: e.notes ?? '',
  };
}

const parseList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function toBody(d: Draft) {
  return {
    trigger_key: d.trigger_key.trim() || null,
    event_name: d.event_name.trim() || null,
    test_event_name: d.test_event_name.trim() || null,
    payload_fields: parseList(d.payload_fields),
    person_attributes: parseList(d.person_attributes),
    webhook_secrets: parseList(d.webhook_secrets),
    test_webhook_secret: d.test_webhook_secret.trim() || null,
    test_webhook_url: d.test_webhook_url.trim() || null,
    payload_template: d.payload_template.trim() || null,
    notes: d.notes.trim() || null,
  };
}

export default function SlugRegistry({
  onValidate,
  onRun,
  runPending,
}: {
  onValidate: (slug: string) => void;
  onRun: (slug: string) => void;
  runPending?: boolean;
}) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const [{ rq }, setUrl] = useUrlFilters({ rq: '' });
  /* Which entry the form is open for: null closed, '' adding, slug editing.
     Transient UI — deliberately not in the URL. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const listQuery = useQuery({
    queryKey: ['slugs'],
    queryFn: () => api.get<SlugListResponse>('/api/slugs'),
  });

  const entries = (listQuery.data?.slugs ?? []).filter(
    (e) =>
      !rq ||
      e.slug.toLowerCase().includes(rq.toLowerCase()) ||
      humanizeSlug(e.slug).toLowerCase().includes(rq.toLowerCase())
  );

  function openAdd() {
    /* Seed the slug from the search box — searching for a campaign that isn't
       registered yet is the natural first step of registering it. */
    setDraft({ ...EMPTY_DRAFT, slug: rq.trim() });
    setEditing('');
  }

  function openEdit(e: SlugEntry) {
    setDraft(toDraft(e));
    setEditing(e.slug);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registered campaigns</CardTitle>
        <CardDescription>
          Campaigns the tester knows how to validate and run — Run test fires the campaign's twin
          end to end to a fresh test identity, Validate checks the wiring without sending anything.
          To register one, enter its slug and check against Customer.io — the check fills in
          everything discoverable from the workspace and tells you what's missing before you save.
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
          {canEdit && editing === null && (
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
            {rq.trim() && canEdit && editing === null && (
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
                <TableHead>Test event</TableHead>
                <TableHead>Prod event</TableHead>
                <TableHead>Runner</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.slug}>
                  <TableCell>
                    <span className="font-medium whitespace-nowrap">{humanizeSlug(e.slug)}</span>
                    <code className="block text-xs text-muted-foreground">{e.slug}</code>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.test_event_name ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{e.event_name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={e.runnable ? 'default' : 'secondary'}>
                      {e.runnable ? 'Runnable' : 'Not runnable'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                    {e.updated_at ? relativeFrom(e.updated_at) : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {canEdit && e.runnable && (
                        <Button size="sm" disabled={runPending} onClick={() => onRun(e.slug)}>
                          Run test
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => onValidate(e.slug)}>
                        Validate
                      </Button>
                      {canEdit && (
                        <Button size="sm" variant="ghost" onClick={() => openEdit(e)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {editing !== null && (
          <SlugForm
            key={editing || '__new__'}
            existingSlug={editing || null}
            draft={draft}
            setDraft={setDraft}
            defaultTemplate={listQuery.data?.default_payload_template ?? ''}
            tokens={listQuery.data?.payload_tokens ?? {}}
            onClose={() => setEditing(null)}
            onCommitted={() => {
              setEditing(null);
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

function SlugForm({
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
    mutationFn: (d: Draft) =>
      api.put<SlugEntry>(`/api/slugs/${encodeURIComponent(d.slug.trim())}`, toBody(d)),
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
        <div className="grid gap-2">
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
          <Label htmlFor="reg-trigger-key">Trigger key (trigger hub)</Label>
          <Input
            id="reg-trigger-key"
            placeholder="e.g. tb_signup"
            value={draft.trigger_key}
            onChange={(e) => set({ trigger_key: e.target.value })}
          />
        </div>
        {/* Test on the left, prod on the right — the tester drives the test
            pair; the prod side is reference. */}
        <div className="grid gap-2">
          <Label htmlFor="reg-test-event">Test trigger event (pmy_test_…)</Label>
          <Input
            id="reg-test-event"
            placeholder="pmy_test_…"
            value={draft.test_event_name}
            onChange={(e) => set({ test_event_name: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-event">Prod trigger event</Label>
          <Input
            id="reg-event"
            placeholder="event the live journey listens on"
            value={draft.event_name}
            onChange={(e) => set({ event_name: e.target.value })}
          />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="reg-test-url">Test webhook URL</Label>
          <Input
            id="reg-test-url"
            className="max-w-full font-mono text-xs"
            placeholder="https://api.customer.io/v1/webhook/…"
            value={draft.test_webhook_url}
            onChange={(e) => set({ test_webhook_url: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Paste it from the twin's [1/2] trigger settings — Customer.io doesn't expose webhook
            URLs via API. Required before the runner can fire this campaign; visible to signed-in
            portal users (internal tool, by design). The live campaign's URL stays with the trigger
            hub and is never entered here.
          </p>
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
          <div className="flex items-center justify-between">
            <Label htmlFor="reg-payload-template">Payload template (JSON, optional)</Label>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!defaultTemplate}
              onClick={() => {
                if (
                  !draft.payload_template.trim() ||
                  window.confirm('Replace the current template with the signup default?')
                ) {
                  set({ payload_template: defaultTemplate });
                }
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
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="reg-notes">Notes</Label>
          <Textarea
            id="reg-notes"
            rows={2}
            className="max-w-full"
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
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
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${existingSlug} from the registry? The Customer.io campaigns are not touched.`
                )
              ) {
                remove.mutate(existingSlug);
              }
            }}
          >
            Remove
          </Button>
        )}
      </div>

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
          <ul className="grid gap-1.5">
            {report.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge variant={findingVariant[f.level]} className="mt-0.5">
                  {f.level}
                </Badge>
                <span className="min-w-0 text-muted-foreground">
                  {f.message}
                  {f.fix && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-2 align-middle"
                      onClick={() => {
                        /* Apply into the draft and re-check; Save persists it
                           through the normal validated path. */
                        const next = { ...draft, [f.fix!.field]: f.fix!.value };
                        setDraft(next);
                        precheck.mutate(next);
                      }}
                    >
                      {f.fix.label}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
