import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Customers() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Customer Activity</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Look up a customer and see their merged CIO + warehouse activity timeline.
        </p>
      </div>
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-muted-foreground">Coming in Phase 3</CardTitle>
          <CardDescription>
            Email lookup → CIO profile, activity timeline (events, sends, opens, clicks) and
            warehouse fan attributes with sync freshness.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
