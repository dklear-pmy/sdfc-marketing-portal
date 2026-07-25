import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { api, type ValidationReport, type CheckStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const statusVariant: Record<CheckStatus, "default" | "destructive" | "secondary" | "outline"> = {
  pass: "default",
  fail: "destructive",
  warn: "secondary",
  skip: "outline",
}

const roleLabel: Record<string, string> = {
  test_trigger: "Test · Trigger [1/2]",
  test_journey: "Test · Journey [2/2]",
  prod_trigger: "Prod · Trigger [1/2]",
  prod_journey: "Prod · Journey [2/2]",
}

export default function Harness() {
  const [slug, setSlug] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  const validation = useMutation({
    mutationFn: (s: string) => api.get<ValidationReport>(`/api/harness/validate/${encodeURIComponent(s)}`),
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!slug.trim()) {
      setFormError("Enter a campaign slug first — the grey text is just an example.")
      return
    }
    setFormError(null)
    validation.mutate(slug.trim())
  }

  const report = validation.data

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Campaign Test Harness</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Validate a campaign's CIO wiring by slug, then run it end-to-end against the mail sink.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Validate wiring</CardTitle>
          <CardDescription>
            Enter the campaign slug as it appears in the CIO campaign names, e.g.{" "}
            <code className="bg-muted rounded px-1 py-0.5">Welcome-General-260715</code>
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
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={validation.isPending}>
              {validation.isPending ? "Validating…" : "Validate"}
            </Button>
          </form>
          {formError && <p className="text-destructive mt-2 text-sm">{formError}</p>}
        </CardContent>
      </Card>

      {validation.isError && (
        <Alert variant="destructive">
          <AlertTitle>Validation request failed</AlertTitle>
          <AlertDescription>{(validation.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Campaign pairs</CardTitle>
              <CardDescription>
                {report.summary.fail === 0
                  ? "All static checks passed."
                  : `${report.summary.fail} check(s) failing.`}{" "}
                Generated {new Date(report.generated_at).toLocaleString()}
              </CardDescription>
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
                      <TableCell className="whitespace-nowrap">{roleLabel[c.role] ?? c.role}</TableCell>
                      <TableCell>{c.id}</TableCell>
                      <TableCell className="max-w-md truncate">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant={c.state === "running" ? "default" : "secondary"}>
                          {c.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.event_name ?? "—"}</TableCell>
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
                        <Badge variant={statusVariant[check.status]}>{check.status}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{check.name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{check.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="text-muted-foreground">Run test campaign</CardTitle>
              <CardDescription>
                Phase 2 — fires the PMY-TEST pair with a fresh scenario identity and tracks
                delivery + engagement through the mail sink.
              </CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
    </div>
  )
}
