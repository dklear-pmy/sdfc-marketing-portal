/* Send a demo webhook: one contract-shaped payload at the campaign's test
   or prod inbound webhook, on demand. The server decides the prod mode from
   the prod [1/2] trigger's LIVE state — draft/stopped seeds the composer's
   Trigger data sample; RUNNING executes Create/Update Person + Send Event
   for real (flow-through), so it requires an owned recipient and verifies
   nothing running listens on the prod event. Same endpoint the Registration
   form's Send sample buttons use; this card surfaces it where the trigger
   work happens. Operator-gated — read-only roles don't see it. */

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SampleResult, type SlugListResponse, type SlugPrecheck } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { prettyPayload } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toBody, toDraft } from '@/components/SlugRegistry';

export default function SampleSender({ slug }: { slug: string }) {
  const { role } = useAuth();
  const canEdit = role === 'operator' || role === 'admin';
  const queryClient = useQueryClient();

  const slugs = useQuery({
    queryKey: ['slugs'],
    queryFn: () => api.get<SlugListResponse>('/api/slugs'),
  });
  const entry = slugs.data?.slugs.find((e) => e.slug === slug);
  const templateText = entry?.payload_template
    ? prettyPayload(entry.payload_template)
    : (slugs.data?.default_payload_template ?? '');

  const [confirmProd, setConfirmProd] = useState(false);
  const [recipient, setRecipient] = useState('');

  /* The payload editor is always visible. null = untouched (tracks the
     registered template, and the send carries no override so the server
     fills the template itself); a string = the operator's edit. Tokens like
     {identity} still fill server-side, and the server refuses any
     email-shaped value that isn't an owned address. */
  const [payloadText, setPayloadText] = useState<string | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const shownPayload = payloadText ?? templateText;

  /* Webhook URLs, editable in place — null = untouched (tracks the saved
     entry). Saving round-trips the FULL registry entry so nothing else on
     it is lost, and the server runs its usual validation (identical
     test/prod URLs are refused, etc.). */
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [prodUrl, setProdUrl] = useState<string | null>(null);
  const shownTestUrl = testUrl ?? entry?.test_webhook_url ?? '';
  const shownProdUrl = prodUrl ?? entry?.prod_webhook_url ?? '';
  const urlsDirty =
    (testUrl !== null && testUrl.trim() !== (entry?.test_webhook_url ?? '')) ||
    (prodUrl !== null && prodUrl.trim() !== (entry?.prod_webhook_url ?? ''));

  const saveUrls = useMutation({
    mutationFn: () => {
      if (!entry) throw new Error('Registry entry not loaded yet');
      const body = {
        ...toBody(toDraft(entry)),
        test_webhook_url: shownTestUrl.trim() || null,
        prod_webhook_url: shownProdUrl.trim() || null,
      };
      // PUT, not POST — the registry's update route (same one SlugRegistry's
      // form uses), so the server's full validation applies.
      return api.put(`/api/slugs/${encodeURIComponent(slug)}`, body);
    },
    onSuccess: () => {
      setTestUrl(null);
      setProdUrl(null);
      void queryClient.invalidateQueries({ queryKey: ['slugs'] });
    },
  });

  /* The edited payload as an object, or undefined to send the registered
     template. Parse errors surface inline and block the send. */
  function editedPayload(): Record<string, unknown> | undefined | 'invalid' {
    if (payloadText === null || payloadText.trim() === templateText.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setPayloadError('The payload must be a JSON object.');
        return 'invalid';
      }
      setPayloadError(null);
      return parsed as Record<string, unknown>;
    } catch (e) {
      setPayloadError(`Not valid JSON: ${(e as Error).message}`);
      return 'invalid';
    }
  }

  /* The prod [1/2]'s live state, fetched only when the prod dialog opens —
     dialog copy only; the server re-verifies at send time. */
  const precheck = useQuery({
    queryKey: ['precheck', slug],
    queryFn: () => api.get<SlugPrecheck>(`/api/slugs/${encodeURIComponent(slug)}/precheck`),
    enabled: confirmProd,
    staleTime: 60_000,
  });
  const prodState = precheck.data?.campaigns.find((c) => c.role === 'prod_trigger')?.state;

  const sample = useMutation({
    mutationFn: ({
      target,
      force,
      recipient: rcpt,
      payload,
    }: {
      target: 'test' | 'prod';
      force?: boolean;
      recipient?: string;
      payload?: Record<string, unknown>;
    }) =>
      api.post<SampleResult>(
        `/api/slugs/${encodeURIComponent(slug)}/sample?target=${target}` +
          `${force ? '&force=true' : ''}` +
          (rcpt ? `&recipient=${encodeURIComponent(rcpt)}` : ''),
        payload ? { payload } : undefined
      ),
  });

  function send(target: 'test' | 'prod', opts: { force?: boolean; recipient?: string } = {}) {
    const payload = editedPayload();
    if (payload === 'invalid') return;
    sample.mutate({ target, payload, ...opts });
  }

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a demo webhook</CardTitle>
        <CardDescription>
          Fires one contract-shaped demo payload at the campaign&apos;s inbound webhook — the same
          POST the hub would make, with sample values. Test goes to the [PMY-TEST] twin. Prod
          depends on the live state of the prod [1/2] trigger: draft stores the payload as the
          composer&apos;s Trigger data and runs nothing; running executes the actions for real, so
          the server demands an owned recipient and verifies nothing is listening on the prod event
          first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ConfirmDialog
          open={confirmProd}
          onOpenChange={setConfirmProd}
          destructive={prodState === 'running'}
          title={
            prodState === 'running'
              ? 'Send a flow-through demo to the PROD webhook?'
              : 'Send a demo payload to the PROD webhook?'
          }
          description={
            precheck.isPending ? (
              'Checking the prod campaign’s live state in Customer.io…'
            ) : prodState === 'running' ? (
              <span className="grid gap-3">
                <span>
                  The prod [1/2] trigger is RUNNING: this send executes Create or Update Person and
                  fires the prod event for the recipient below — the values land on that person in
                  the production workspace. The server verifies first that nothing running listens
                  on the prod event, so with the journey off it stops there.
                </span>
                <Input
                  placeholder="Owned recipient — @pmygroup.com or @sdfc.dev"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                />
                <span>
                  Never a fan address — the server refuses anything not on an owned domain.
                </span>
              </span>
            ) : prodState && ['draft', 'stopped', 'paused'].includes(prodState) ? (
              `The prod campaign is currently ${prodState} — Customer.io stores the payload as Trigger data and runs nothing. The server re-checks the live state before sending.`
            ) : prodState ? (
              `The prod campaign is currently ${prodState.toUpperCase()} — the demo identity would enter the live workflow, so the server will refuse this send unless forced.`
            ) : (
              'The prod campaign state could not be read — the server checks it live and only sends while the campaign is draft or stopped.'
            )
          }
          confirmLabel={prodState === 'running' ? 'Send flow-through demo' : 'Send demo'}
          onConfirm={() => send('prod', { recipient: recipient.trim() || undefined })}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`demo-test-url-${slug}`}>Test webhook URL</Label>
            <Input
              id={`demo-test-url-${slug}`}
              className="font-mono text-xs"
              placeholder="https://api.customer.io/v1/webhook/…"
              value={shownTestUrl}
              onChange={(e) => setTestUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`demo-prod-url-${slug}`}>Prod webhook URL</Label>
            <Input
              id={`demo-prod-url-${slug}`}
              className="font-mono text-xs"
              placeholder="https://api.customer.io/v1/webhook/…"
              value={shownProdUrl}
              onChange={(e) => setProdUrl(e.target.value)}
            />
          </div>
        </div>
        {urlsDirty && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saveUrls.isPending}
              onClick={() => saveUrls.mutate()}
            >
              {saveUrls.isPending ? 'Saving…' : 'Save webhook URLs'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Sends use the saved URL — save before firing. Paste each from the campaign&apos;s
              [1/2] trigger settings; the two look identical but must never be crossed.
            </span>
          </div>
        )}
        {saveUrls.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not save the URLs</AlertTitle>
            <AlertDescription>{(saveUrls.error as Error).message}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor={`demo-payload-${slug}`}>Payload</Label>
          {Object.keys(slugs.data?.payload_tokens ?? {}).length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                Token Definitions
              </summary>
              <div className="mt-2 rounded-md border bg-muted/40 p-2 text-xs">
                <p className="mb-1 text-muted-foreground">
                  Leave these in the payload and the server fills them at send time:
                </p>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {Object.entries(slugs.data?.payload_tokens ?? {}).map(([tok, doc]) => (
                    <Fragment key={tok}>
                      <code>{tok}</code>
                      <span className="text-muted-foreground">{doc}</span>
                    </Fragment>
                  ))}
                </div>
              </div>
            </details>
          )}
          <Textarea
            id={`demo-payload-${slug}`}
            rows={18}
            className="max-w-full font-mono text-xs"
            value={shownPayload}
            onChange={(e) => setPayloadText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            This exact JSON is what fires (tokens like {'{identity}'} still fill server-side — edit
            values freely or replace them). The campaign&apos;s actions key on these values, so
            every email-shaped value must be an owned address — the server refuses anything else, on
            both targets.{' '}
            {payloadText !== null && payloadText.trim() !== templateText.trim() && (
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  setPayloadText(null);
                  setPayloadError(null);
                }}
              >
                Reset to the registered template
              </button>
            )}
          </p>
          {payloadError && <p className="text-xs text-destructive">{payloadError}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!entry?.test_webhook_url || sample.isPending}
            onClick={() => send('test')}
          >
            Send test demo
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!entry?.prod_webhook_url || sample.isPending}
            onClick={() => {
              if (editedPayload() === 'invalid') return;
              setConfirmProd(true);
            }}
          >
            Send prod demo
          </Button>
          {entry && !entry.test_webhook_url && (
            <span className="text-xs text-muted-foreground">
              No test webhook URL saved yet — enter it above and save.
            </span>
          )}
          {entry && entry.test_webhook_url && !entry.prod_webhook_url && (
            <span className="text-xs text-muted-foreground">
              No prod webhook URL saved yet — enter it above and save.
            </span>
          )}
        </div>

        {sample.isError && (
          <Alert variant="destructive">
            <AlertTitle>Demo not sent</AlertTitle>
            <AlertDescription>{(sample.error as Error).message}</AlertDescription>
            {(sample.error as Error).message.includes('force') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 w-fit"
                disabled={sample.isPending}
                onClick={() => send('prod', { force: true })}
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
                ? `Flow-through demo delivered to the prod webhook (HTTP ${sample.data.status_code})`
                : `Demo delivered to the ${sample.data.target} webhook (HTTP ${sample.data.status_code})`}
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
                      Search {sample.data.identity} under People in Customer.io to inspect the
                      values that came through.
                    </>
                  )}
                </>
              ) : (
                <>
                  Open the campaign&apos;s composer and pick the newest Trigger data sample —
                  trigger.* references now validate against the contract payload for{' '}
                  {sample.data.identity}.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
