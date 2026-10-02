import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SpendRecipient, type SpendRecipientsResponse } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type ListName = SpendRecipient['list_name'];

const LISTS: { name: ListName; title: string; blurb: string }[] = [
  {
    name: 'spend_critical',
    title: 'Critical (immediate)',
    blurb:
      'One email per finding, at most once a day while it stays open: ceiling breaches, two hours of high totals, and any change projected at $200/month or more.',
  },
  {
    name: 'spend_digest',
    title: 'Daily digest',
    blurb:
      '06:00 Pacific. Skipped on quiet days except Mondays. Yesterday against approved, month to date, projection, open findings, baselines awaiting acceptance.',
  },
];

function RecipientList({
  name,
  title,
  blurb,
  rows,
}: {
  name: ListName;
  title: string;
  blurb: string;
  rows: SpendRecipient[];
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['spend-alert-recipients'] });

  const add = useMutation({
    mutationFn: () =>
      api.post<SpendRecipient>(`/api/admin/spend-alert-recipients/${name}`, {
        email,
        label: label || null,
      }),
    onSuccess: () => {
      setEmail('');
      setLabel('');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (target: string) =>
      api.del<{ email: string }>(
        `/api/admin/spend-alert-recipients/${name}/${encodeURIComponent(target)}`
      ),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<{ sent_to: string[] }>(`/api/admin/spend-alert-recipients/${name}/test`, {}),
  });

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) add.mutate();
  }

  const error = add.error ?? remove.error ?? test.error;
  return (
    <div className="grid gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{blurb}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={test.isPending || rows.length === 0}
          onClick={() => test.mutate()}
        >
          {test.isPending ? 'Sending…' : 'Send test'}
        </Button>
      </div>
      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-56 flex-1 gap-2">
          <Label htmlFor={`${name}-email`}>Email</Label>
          <Input
            id={`${name}-email`}
            type="email"
            required
            placeholder="name@pmygroup.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid min-w-44 gap-2">
          <Label htmlFor={`${name}-label`}>Label</Label>
          <Input
            id={`${name}-label`}
            placeholder="e.g. Dean"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
      </form>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}
      {test.isSuccess && (
        <Alert>
          <AlertDescription>Test sent to {test.data.sent_to.join(', ')}.</AlertDescription>
        </Alert>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Empty: emails fall back to the configured fallback address.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Added by</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.email}>
                  <TableCell>{r.email}</TableCell>
                  <TableCell className="text-muted-foreground">{r.label ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.added_by ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(r.email)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function SpendAlertRecipientsCard() {
  const recipients = useQuery<SpendRecipientsResponse>({
    queryKey: ['spend-alert-recipients'],
    queryFn: () => api.get('/api/admin/spend-alert-recipients'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform spend alerts</CardTitle>
        <CardDescription>
          Who hears from the BigQuery spend monitor, via Postmark from alerts@sdfc.dev. Two lists,
          both data in platform_ops.alert_recipients.
          {recipients.data?.fallback && <> Empty lists fall back to {recipients.data.fallback}.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {recipients.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(recipients.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {LISTS.map((l) => (
          <RecipientList key={l.name} {...l} rows={recipients.data?.lists[l.name] ?? []} />
        ))}
      </CardContent>
    </Card>
  );
}
