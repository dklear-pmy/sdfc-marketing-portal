/* Loading UI for the Matching Customers table, shared by the Trigger Manager
   and the campaign drilldown so both windows behave identically.

   Why a real skeleton and not just dimming: both previews keep the previous
   result as placeholder data while the next one loads, so switching Next Run
   ↔ Last 90 Days used to leave the OLD window's rows and count on screen —
   dimmed, but readable and wrong — for the several seconds the warehouse
   query takes (the history table function scans 90 days). A stale "1 customer
   currently selected" under a Last 90 Days tab reads as an answer, not as
   work in progress. */

import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/* Row count is cosmetic — enough to read as a table, short enough not to
   shove the pager off-screen. */
const ROWS = 5;

export function PreviewCountSkeleton() {
  return <Skeleton className="h-5 w-56" />;
}

export function PreviewTableSkeleton() {
  return (
    <div className="overflow-x-auto rounded-md border" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading matching customers…</span>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead className="w-24">Payload</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: ROWS }, (_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-3 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-36" />
                <Skeleton className="mt-1 h-3 w-48" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-8 w-14" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
