import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Tripwires() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Tripwire Accounts</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Sentinel identities that must never (or must always) receive sends — latest assertion
          status and history.
        </p>
      </div>
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-muted-foreground">Coming in Phase 4</CardTitle>
          <CardDescription>
            Daily assertions over the tripwire registry (unsub latch intact, sync freshness,
            unexpected deliveries) with red/green status and failing-check detail.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
