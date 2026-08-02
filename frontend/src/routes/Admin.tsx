import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ROLE_LABELS, SECTIONS, SECTION_LABELS, type Role, type Section } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PortalUser {
  uid: string;
  email: string | null;
  portal_role: string | null;
  /* null = pre-sections account: full access until explicit grants are stamped. */
  portal_sections: string[] | null;
  providers: string[];
  disabled: boolean;
}

interface AlertRecipient {
  email: string;
  label: string | null;
  added_by: string | null;
  added_at: string | null;
}

interface InviteResult {
  uid: string;
  email: string;
  portal_role: string;
  portal_sections: string[] | null;
  created: boolean;
  invite_link: string;
}

const ROLES = ['viewer', 'operator', 'admin'] as const;

/* What this user can currently see — mirrors the API's resolution: a missing
   grants list means legacy full access. */
function userSections(u: PortalUser): Section[] {
  if (u.portal_sections == null) return [...SECTIONS];
  return SECTIONS.filter((s) => u.portal_sections!.includes(s));
}

function SectionChips({
  value,
  disabled,
  onToggle,
}: {
  value: Section[];
  disabled?: boolean;
  onToggle: (s: Section) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {SECTIONS.map((s) => {
        const active = value.includes(s);
        return (
          <Button
            key={s}
            type="button"
            variant={active ? 'secondary' : 'outline'}
            size="sm"
            disabled={disabled}
            className={active ? '' : 'text-muted-foreground'}
            aria-pressed={active}
            onClick={() => onToggle(s)}
          >
            {SECTION_LABELS[s]}
          </Button>
        );
      })}
    </div>
  );
}

export default function Admin() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('viewer');
  const [inviteSections, setInviteSections] = useState<Section[]>([...SECTIONS]);
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ users: PortalUser[] }>('/api/admin/users'),
  });

  const invite = useMutation({
    mutationFn: () =>
      api.post<InviteResult>('/api/admin/invites', {
        email,
        role,
        // Admins hold every section implicitly — send no grants.
        sections: role === 'admin' ? null : inviteSections,
      }),
    onSuccess: (result) => {
      setLastInvite(result);
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const setUserRole = useMutation({
    mutationFn: ({
      uid,
      newRole,
      sections,
    }: {
      uid: string;
      newRole: string | null;
      sections?: Section[];
    }) =>
      api.put<PortalUser>(`/api/admin/users/${uid}/role`, {
        role: newRole,
        // Omitted = leave the user's grants untouched (role-only change).
        sections: sections ?? null,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  function onInvite(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) invite.mutate();
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite teammates, set their portal role, and choose which sections they can see. Role =
          what they can do (viewer reads, operator runs and edits); sections = which areas exist for
          them. Changes reach a signed-in user within an hour, or immediately after they sign out
          and back in.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite</CardTitle>
          <CardDescription>
            Google-workspace users can just sign in with Google after this — the role is what
            unlocks access. The generated link sets a password for optional email/password sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form onSubmit={onInvite} className="flex flex-wrap items-end gap-3">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                placeholder="name@pmygroup.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Tabs value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <TabsList>
                {ROLES.map((r) => (
                  <TabsTrigger key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Inviting…' : 'Invite'}
            </Button>
            <div className="grid w-full gap-2">
              <Label>Sections</Label>
              {role === 'admin' ? (
                <p className="text-sm text-muted-foreground">Admins see every section.</p>
              ) : (
                <SectionChips
                  value={inviteSections}
                  disabled={invite.isPending}
                  onToggle={(s) =>
                    setInviteSections((cur) =>
                      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]
                    )
                  }
                />
              )}
            </div>
          </form>

          {invite.isError && (
            <Alert variant="destructive">
              <AlertTitle>Invite failed</AlertTitle>
              <AlertDescription>{(invite.error as Error).message}</AlertDescription>
            </Alert>
          )}

          {lastInvite && (
            <Alert>
              <AlertTitle>
                {lastInvite.created ? 'Invited' : 'Access updated for existing account'}:{' '}
                {lastInvite.email} (
                {ROLE_LABELS[lastInvite.portal_role as Role] ?? lastInvite.portal_role}
                {lastInvite.portal_role !== 'admin' && lastInvite.portal_sections
                  ? ` — ${lastInvite.portal_sections
                      .map((s) => SECTION_LABELS[s as Section] ?? s)
                      .join(', ')}`
                  : ''}
                )
              </AlertTitle>
              <AlertDescription>
                <div className="grid gap-2">
                  <span>Password-set link (share it if they'll use email/password sign-in):</span>
                  <div className="flex items-center gap-2">
                    <code className="max-w-xl truncate rounded bg-muted px-1.5 py-0.5 text-xs">
                      {lastInvite.invite_link}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigator.clipboard.writeText(lastInvite.invite_link)}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <AlertRecipientsCard />

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Everyone with portal access. To add someone new, use Invite — an existing account gets
            the role added in place; revoking removes them from this list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.isError && (
            <Alert variant="destructive">
              <AlertTitle>Could not load users</AlertTitle>
              <AlertDescription>{(users.error as Error).message}</AlertDescription>
            </Alert>
          )}
          {setUserRole.isError && (
            <Alert variant="destructive">
              <AlertTitle>Role change failed</AlertTitle>
              <AlertDescription>{(setUserRole.error as Error).message}</AlertDescription>
            </Alert>
          )}
          {users.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Portal role</TableHead>
                  <TableHead>Sections</TableHead>
                  <TableHead>Sign-in</TableHead>
                  <TableHead className="text-right">Change role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Client-side guard mirrors the server filter: portal users only. */}
                {users.data.users
                  .filter((u) => u.portal_role)
                  .map((u) => (
                    <TableRow key={u.uid}>
                      <TableCell>{u.email ?? u.uid}</TableCell>
                      <TableCell>
                        {u.portal_role ? (
                          <Badge>{ROLE_LABELS[u.portal_role as Role] ?? u.portal_role}</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.portal_role === 'admin' ? (
                          <Badge variant="outline">all sections</Badge>
                        ) : (
                          <div className="grid gap-1">
                            <SectionChips
                              value={userSections(u)}
                              disabled={setUserRole.isPending}
                              onToggle={(s) => {
                                const cur = userSections(u);
                                const next = cur.includes(s)
                                  ? cur.filter((x) => x !== s)
                                  : [...cur, s];
                                setUserRole.mutate({
                                  uid: u.uid,
                                  newRole: u.portal_role,
                                  sections: next,
                                });
                              }}
                            />
                            {u.portal_sections == null && (
                              <span className="text-xs text-muted-foreground">
                                full access from before sections existed — any toggle makes grants
                                explicit
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {u.providers.join(', ') || '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {ROLES.filter((r) => r !== u.portal_role).map((r) => (
                            <Button
                              key={r}
                              variant="outline"
                              size="sm"
                              disabled={setUserRole.isPending}
                              onClick={() => setUserRole.mutate({ uid: u.uid, newRole: r })}
                            >
                              {ROLE_LABELS[r]}
                            </Button>
                          ))}
                          {u.portal_role && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={setUserRole.isPending}
                              onClick={() => setUserRole.mutate({ uid: u.uid, newRole: null })}
                            >
                              Revoke
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AlertRecipientsCard() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');

  const recipients = useQuery({
    queryKey: ['alert-recipients'],
    queryFn: () =>
      api.get<{ recipients: AlertRecipient[]; fallback: string | null }>(
        '/api/admin/alert-recipients'
      ),
  });

  const add = useMutation({
    mutationFn: () =>
      api.post<AlertRecipient>('/api/admin/alert-recipients', { email, label: label || null }),
    onSuccess: () => {
      setEmail('');
      setLabel('');
      void queryClient.invalidateQueries({ queryKey: ['alert-recipients'] });
    },
  });

  const remove = useMutation({
    mutationFn: (target: string) =>
      api.del<{ email: string }>(`/api/admin/alert-recipients/${encodeURIComponent(target)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['alert-recipients'] }),
  });

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) add.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert recipients</CardTitle>
        <CardDescription>
          Who gets notified when something breaks — tripwire failures and unattended test-run
          failures. Shared inboxes welcome. Failures email immediately, remind hourly until
          resolved, and confirm when fixed.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-56 flex-1 gap-2">
            <Label htmlFor="recip-email">Email</Label>
            <Input
              id="recip-email"
              type="email"
              required
              placeholder="marketing@sandiegofc.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid min-w-44 gap-2">
            <Label htmlFor="recip-label">Label</Label>
            <Input
              id="recip-label"
              placeholder="e.g. Marketing shared inbox"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add recipient'}
          </Button>
        </form>
        {(add.isError || remove.isError) && (
          <Alert variant="destructive">
            <AlertDescription>{((add.error ?? remove.error) as Error).message}</AlertDescription>
          </Alert>
        )}
        {recipients.data && (
          <>
            {recipients.data.fallback && (
              <Alert>
                <AlertDescription>
                  No recipients configured — alerts fall back to {recipients.data.fallback}.
                </AlertDescription>
              </Alert>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.data.recipients.map((r) => (
                  <TableRow key={r.email}>
                    <TableCell className="font-medium">{r.email}</TableCell>
                    <TableCell className="text-muted-foreground">{r.label ?? '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.added_by ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
