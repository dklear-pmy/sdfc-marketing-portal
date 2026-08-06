import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SlugVariables } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanizeSlug, relativeFrom } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { HoverTip } from '@/components/ui/hover-tip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/* One row of the matrix: where a field exists, and which emails use it. */
interface FieldRow {
  field: string;
  inTemplate: boolean;
  inContract: boolean;
  seTest: boolean | null; // null = that trigger half wasn't readable
  seProd: boolean | null;
  personAttr: boolean;
  /* Registry-declared journey entry-filter input (not API-verifiable). */
  journeyFilter: boolean;
  /* One entry per distinct {{scope.field}} variable; tooltip holds where it
     appears with surrounding email text. */
  usage: { variable: string; tooltip: string }[];
}

function buildRows(v: SlugVariables): FieldRow[] {
  const test = v.cio.find((c) => c.role === 'test_trigger');
  const prod = v.cio.find((c) => c.role === 'prod_trigger');
  const personAttrs = new Set([
    ...v.registry.person_attributes,
    ...v.cio.flatMap((c) => c.person_attribute_fields),
  ]);
  const all = [
    ...v.template.keys,
    ...v.registry.payload_fields,
    ...(test?.send_event_fields ?? []),
    ...(prod?.send_event_fields ?? []),
    ...personAttrs,
    ...v.registry.filter_fields,
    ...v.liquid.map((l) => l.field),
  ];
  /* Template order first (it's what the runner sends), extras after. */
  const ordered = [...new Set([...v.template.keys, ...all.sort()])];
  return ordered.map((field) => {
    /* One chip per distinct variable; test/prod pairs referencing the same
       variable merge, their contexts pooled into the tooltip. */
    const byVariable = new Map<string, Set<string>>();
    for (const l of v.liquid.filter((l) => l.field === field)) {
      const variable = `{{${l.scope}.${field}}}`;
      const lines = byVariable.get(variable) ?? new Set<string>();
      for (const c of l.contexts ?? []) lines.add(`${c.email} (${l.pair}):\n“${c.context}”`);
      if (!(l.contexts ?? []).length) for (const e of l.emails) lines.add(`${e} (${l.pair})`);
      byVariable.set(variable, lines);
    }
    return {
      field,
      inTemplate: v.template.keys.includes(field),
      inContract: v.registry.payload_fields.includes(field),
      seTest: test ? (test.send_event_fields?.includes(field) ?? false) : null,
      seProd: prod ? (prod.send_event_fields?.includes(field) ?? false) : null,
      personAttr: personAttrs.has(field),
      journeyFilter: v.registry.filter_fields.includes(field),
      usage: [...byVariable.entries()].map(([variable, lines]) => ({
        variable,
        tooltip: [...lines].join('\n\n'),
      })),
    };
  });
}

/* The paste-ready Send Event body for CIO's Build event editor (JSON →
   JavaScript mode), generated from the payload contract so chat-copied
   variants can't drift. trigger.* refs = the incoming webhook payload. */
function sendEventSnippet(fields: string[]): string {
  return `return {\n${fields.map((f) => `  "${f}": trigger.${f}`).join(',\n')}\n};`;
}

function Mark({ value, warn }: { value: boolean | null; warn?: boolean }) {
  if (value === null) return <span className="text-muted-foreground">?</span>;
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className={warn ? 'font-medium text-amber-600 dark:text-amber-400' : ''}>✓</span>;
}

export default function SlugVariablesPanel({
  slug,
  onClose,
}: {
  slug: string;
  /* Omitted when the panel's visibility is tied to a selection elsewhere. */
  onClose?: () => void;
}) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['slug-variables', slug],
    queryFn: () => api.get<SlugVariables>(`/api/slugs/${encodeURIComponent(slug)}/variables`),
  });

  const refresh = useMutation({
    mutationFn: () =>
      api.post<SlugVariables>(`/api/slugs/${encodeURIComponent(slug)}/variables/refresh`),
    onSuccess: (data) => {
      queryClient.setQueryData(['slug-variables', slug], data);
      void queryClient.invalidateQueries({ queryKey: ['slugs'] });
    },
  });

  const v = query.data;
  const rows = v ? buildRows(v) : [];

  const snippetFields = v
    ? v.registry.payload_fields.length
      ? v.registry.payload_fields
      : v.template.keys
    : [];
  const snippet = sendEventSnippet(snippetFields);
  const [copied, setCopied] = useState(false);
  const copySnippet = () => {
    void navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{humanizeSlug(slug)} — variables</CardTitle>
            <CardDescription>
              Side by side: what the runner sends, the registry contract, what each Customer.io
              trigger actually maps onto its Send Event, and which emails use which variable.
              {v && <> Checked {relativeFrom(v.generated_at)}.</>}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                {refresh.isPending ? 'Refreshing…' : 'Refresh contract from Customer.io'}
              </Button>
            )}
            {onClose && (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {query.isPending && <p className="text-sm text-muted-foreground">Reading Customer.io…</p>}
        {query.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load variables</AlertTitle>
            <AlertDescription>{(query.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {refresh.isError && (
          <Alert variant="destructive">
            <AlertTitle>Refresh failed</AlertTitle>
            <AlertDescription>{(refresh.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {v && (
          <>
            <div className="grid gap-1.5">
              {v.cio.map((c) => {
                const covered = !!c.recipient_field && v.template.keys.includes(c.recipient_field);
                return (
                  <p key={c.role} className="text-sm" title={c.campaign_name ?? undefined}>
                    <span className="font-medium">
                      {c.role === 'test_trigger' ? 'Test twin' : 'Prod trigger'}
                    </span>{' '}
                    resolves people by{' '}
                    <code className="text-xs">{c.recipient_field ?? 'unknown'}</code>{' '}
                    {covered ? (
                      <Badge variant="outline">in payload</Badge>
                    ) : (
                      <Badge variant="destructive">not in payload — creates nobody</Badge>
                    )}
                  </p>
                );
              })}
              {v.cio.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No trigger campaigns readable for this slug — check the naming convention.
                </p>
              )}
            </div>

            {snippetFields.length > 0 && (
              <div className="rounded-md border">
                <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">
                      Send Event mapping — paste into Customer.io
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Generated from this campaign&apos;s payload contract. In each [1/2] trigger
                      campaign: Send Event → Build event → JSON → JavaScript — replace the editor
                      contents with this block. The EVENT NAME box stays per half (test uses the
                      pmy_test_… name); leave &quot;Who do you want to update?&quot; as email =
                      trigger attribute email. The harness&apos;s test payload is separate — it
                      lives on the Registration tab and is sent automatically by Run test.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={copySnippet}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </Button>
                </div>
                <pre className="overflow-x-auto border-t bg-muted/40 p-3 text-xs">{snippet}</pre>
              </div>
            )}

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead title="What the runner POSTs (payload template)">Runner</TableHead>
                    <TableHead title="Registry payload contract">Contract</TableHead>
                    <TableHead title="Mapped on the test twin's Send Event action — what the test journey's event carries">
                      <span className="block leading-tight">Send Event</span>
                      <span className="block leading-tight">(test)</span>
                    </TableHead>
                    <TableHead title="Mapped on the prod trigger's Send Event action — what the live journey's event carries">
                      <span className="block leading-tight">Send Event</span>
                      <span className="block leading-tight">(prod)</span>
                    </TableHead>
                    <TableHead title="Declared input to the journey's entry-filter conditions — Customer.io does not expose filter conditions via API, so this list is maintained on the Registration tab">
                      <span className="block leading-tight">Journey</span>
                      <span className="block leading-tight">filtering</span>
                    </TableHead>
                    <TableHead title="Set as a person attribute">Person</TableHead>
                    <TableHead title="Hover a variable for the surrounding email text">
                      Used in emails
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.field}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {r.field}
                      </TableCell>
                      <TableCell>
                        <Mark value={r.inTemplate} />
                      </TableCell>
                      <TableCell>
                        <Mark value={r.inContract} warn={r.inContract && !r.inTemplate} />
                      </TableCell>
                      {/* A Send Event mapping for a field the runner never sends
                          forwards an empty value — amber, not a clean tick. */}
                      <TableCell>
                        <Mark value={r.seTest} warn={!!r.seTest && !r.inTemplate} />
                      </TableCell>
                      <TableCell>
                        <Mark value={r.seProd} warn={!!r.seProd && !r.inTemplate} />
                      </TableCell>
                      <TableCell>
                        <Mark value={r.journeyFilter} />
                      </TableCell>
                      <TableCell>
                        <Mark value={r.personAttr} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.usage.length
                          ? r.usage.map((u) => (
                              <HoverTip key={u.variable} content={u.tooltip}>
                                <code className="mr-1.5 underline decoration-dotted underline-offset-2">
                                  {u.variable}
                                </code>
                              </HoverTip>
                            ))
                          : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-xs text-muted-foreground">
              Journey filtering ✓ = declared input to the journey's entry-filter conditions
              (Customer.io does not expose filter conditions via API — maintain the list on the
              Registration tab). Amber ✓ = mapped in Customer.io but absent from the runner payload,
              so it forwards empty on test runs (and flags contract drift to fix in the trigger's
              Send Event mapping). Refresh overwrites the registry's payload contract with what
              Customer.io maps right now and merges newly-set person attributes; the payload
              template is never touched.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
