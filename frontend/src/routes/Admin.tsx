import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface PortalUser {
  uid: string
  email: string | null
  portal_role: string | null
  providers: string[]
  disabled: boolean
}

interface InviteResult {
  uid: string
  email: string
  portal_role: string
  created: boolean
  invite_link: string
}

const ROLES = ["viewer", "operator", "admin"] as const

export default function Admin() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<(typeof ROLES)[number]>("viewer")
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null)

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.get<{ users: PortalUser[] }>("/api/admin/users"),
  })

  const invite = useMutation({
    mutationFn: () => api.post<InviteResult>("/api/admin/invites", { email, role }),
    onSuccess: (result) => {
      setLastInvite(result)
      setEmail("")
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] })
    },
  })

  const setUserRole = useMutation({
    mutationFn: ({ uid, newRole }: { uid: string; newRole: string | null }) =>
      api.put<PortalUser>(`/api/admin/users/${uid}/role`, { role: newRole }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  })

  function onInvite(e: FormEvent) {
    e.preventDefault()
    if (email.trim()) invite.mutate()
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Invite teammates and manage their portal roles.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite</CardTitle>
          <CardDescription>
            Google-workspace users can just sign in with Google after this — the role is what
            unlocks access. The generated link sets a password for optional email/password
            sign-in.
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
                    {r}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? "Inviting…" : "Invite"}
            </Button>
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
                {lastInvite.created ? "Invited" : "Role updated for existing account"}:{" "}
                {lastInvite.email} ({lastInvite.portal_role})
              </AlertTitle>
              <AlertDescription>
                <div className="grid gap-2">
                  <span>Password-set link (share it if they'll use email/password sign-in):</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted max-w-xl truncate rounded px-1.5 py-0.5 text-xs">
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

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Everyone with portal access. To add someone new, use Invite — an existing account
            gets the role added in place; revoking removes them from this list.
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
                  <TableHead>Sign-in</TableHead>
                  <TableHead className="text-right">Change role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Client-side guard mirrors the server filter: portal users only. */}
                {users.data.users.filter((u) => u.portal_role).map((u) => (
                  <TableRow key={u.uid}>
                    <TableCell>{u.email ?? u.uid}</TableCell>
                    <TableCell>
                      {u.portal_role ? (
                        <Badge>{u.portal_role}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {u.providers.join(", ") || "—"}
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
                            {r}
                          </Button>
                        ))}
                        {u.portal_role && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={setUserRole.isPending}
                            onClick={() => setUserRole.mutate({ uid: u.uid, newRole: null })}
                          >
                            revoke
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
  )
}
