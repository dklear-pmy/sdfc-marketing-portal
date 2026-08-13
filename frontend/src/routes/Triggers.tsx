import { useNavigate } from 'react-router';
import TriggersPanel from '@/components/TriggersPanel';

/* The warehouse triggers behind the campaign webhooks, as their own area —
   campaign links inside a trigger drilldown jump over to Campaign Tester. */
export default function Triggers() {
  const navigate = useNavigate();
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Trigger Manager</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The warehouse triggers that fire campaign webhooks — what each one watches for, who it
          would touch, and the emergency stops.
        </p>
      </div>
      <TriggersPanel
        onSelect={(slug) => void navigate(`/harness?sel=${encodeURIComponent(slug)}`)}
      />
    </div>
  );
}
