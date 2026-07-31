import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* Section-navigation tabs in the SDFC talent-platform drilldown style: a
   bottom-bordered row where the active tab carries a colored underline
   (border-b-2 -mb-px over the nav's border-b). Use this for switching between
   CONTENT SECTIONS; value filters (status, time window, metric) keep the
   segmented `Tabs` pills. */
export function UnderlineTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: readonly { key: T; label: ReactNode }[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        /* Scrollable on narrow screens but never SHOWS a scrollbar — a visible
           bar under the tab row reads as broken layout. */
        'flex justify-start overflow-x-auto border-b border-border',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            '-mb-px border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.key
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
          )}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
