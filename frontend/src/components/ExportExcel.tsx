/* "Export Excel" for the Matching Customers previews — downloads the WHOLE
   current window (not just the visible page) as one .xlsx, payload fields
   flattened into columns. The server names the file after the trigger and
   window. No Toaster is mounted in this app, so failures surface inline
   beside the button. */

import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function ExportExcelButton({
  path,
  disabled,
  label = 'Export Excel',
}: {
  path: string;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => {
          setError(null);
          setBusy(true);
          api
            .download(path)
            .catch((e) => setError((e as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Exporting…' : label}
      </Button>
    </span>
  );
}
