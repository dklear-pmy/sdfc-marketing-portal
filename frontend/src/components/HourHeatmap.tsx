import { useState } from 'react';
import type { SpendHeatCell } from '@/lib/api';
import { cn } from '@/lib/utils';

/* Seven days by 24 Pacific hours. Each cell is actual ÷ same-hour baseline, so the
   nightly Dataform spikes read as neutral and a regression reads as a band that
   starts at a visible hour. Diverging scale: blue under, neutral near 1×, red over,
   with equal three-step arms; the hovered or focused cell is read out below the
   grid and every value is also in the DAG table, so color never carries alone. */

const STEPS: { max: number; label: string; cls: string }[] = [
  { max: 0.4, label: '<0.4×', cls: 'bg-[#256abf] dark:bg-[#6da7ec]' },
  { max: 0.6, label: '0.4–0.6×', cls: 'bg-[#5598e7] dark:bg-[#2a78d6]' },
  { max: 0.8, label: '0.6–0.8×', cls: 'bg-[#9ec5f4] dark:bg-[#184f95]' },
  { max: 1.25, label: '0.8–1.25×', cls: 'bg-[#e9e8e3] dark:bg-[#383835]' },
  { max: 1.5, label: '1.25–1.5×', cls: 'bg-[#f4b9b8] dark:bg-[#6e2a29]' },
  { max: 2.0, label: '1.5–2×', cls: 'bg-[#e98482] dark:bg-[#a94442]' },
  { max: Infinity, label: '>2×', cls: 'bg-[#cf3f3d] dark:bg-[#e66767]' },
];

function stepFor(ratio: number | null) {
  if (ratio == null) return null;
  return STEPS.find((s) => ratio < s.max) ?? STEPS[STEPS.length - 1];
}

const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);

export function HourHeatmap({ cells }: { cells: SpendHeatCell[] }) {
  const [hover, setHover] = useState<SpendHeatCell | null>(null);
  // Group by Pacific day; hour_pt is "Thu 10/2 1 AM" from the API, day is the first two tokens.
  const days = new Map<string, (SpendHeatCell | null)[]>();
  for (const c of cells) {
    const d = new Date(c.hour);
    const key = d.toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
    });
    const hour = Number(
      d
        .toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          hour: 'numeric',
          hour12: false,
        })
        .replace('24', '0')
    );
    if (!days.has(key))
      days.set(
        key,
        Array.from({ length: 24 }, () => null)
      );
    days.get(key)![hour] = c;
  }
  const rows = [...days.entries()];
  const hourLabels = Array.from({ length: 24 }, (_, h) =>
    h % 6 === 0 ? (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`) : ''
  );

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[560px] gap-[2px]"
          style={{ gridTemplateColumns: '5.5rem repeat(24, minmax(0, 1fr))' }}
        >
          <div />
          {hourLabels.map((l, i) => (
            <div key={i} className="text-[10px] leading-none text-muted-foreground">
              {l}
            </div>
          ))}
          {rows.map(([day, hours]) => (
            <div key={day} className="contents">
              <div className="pr-2 text-xs leading-5 text-muted-foreground tabular-nums">{day}</div>
              {hours.map((c, h) => {
                const step = c ? stepFor(c.ratio) : null;
                const empty = !c || c.actual == null;
                return (
                  <button
                    key={h}
                    type="button"
                    aria-label={
                      c
                        ? `${c.hour_pt}: ${money(c.actual)} against ${money(c.baseline)} baseline`
                        : 'no data'
                    }
                    onPointerEnter={() => c && setHover(c)}
                    onFocus={() => c && setHover(c)}
                    onPointerLeave={() => setHover(null)}
                    onBlur={() => setHover(null)}
                    className={cn(
                      'h-5 rounded-[3px] border border-transparent transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      empty ? 'border-border/60 bg-transparent' : step?.cls,
                      !empty &&
                        c &&
                        c.baseline == null &&
                        'bg-sdfc-chrome-light dark:bg-sdfc-chrome-dark'
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
        <p className="min-h-4 text-muted-foreground tabular-nums">
          {hover ? (
            <>
              <span className="font-medium text-foreground">{hover.hour_pt} PT</span> ·{' '}
              {money(hover.actual)} actual · {money(hover.baseline)} same-hour baseline
              {hover.ratio != null && <> · {hover.ratio.toFixed(2)}×</>}
            </>
          ) : (
            'Hover a cell for the hour, actual and baseline. Baseline = median of the same hour over the prior four weeks.'
          )}
        </p>
        <ul
          className="flex flex-wrap items-center gap-2"
          aria-label="Legend: actual divided by baseline"
        >
          {STEPS.map((s) => (
            <li key={s.label} className="flex items-center gap-1 text-muted-foreground">
              <span className={cn('inline-block size-3 rounded-[2px]', s.cls)} aria-hidden />{' '}
              {s.label}
            </li>
          ))}
          <li className="flex items-center gap-1 text-muted-foreground">
            <span
              className="inline-block size-3 rounded-[2px] bg-sdfc-chrome-light dark:bg-sdfc-chrome-dark"
              aria-hidden
            />{' '}
            no baseline
          </li>
        </ul>
      </div>
    </div>
  );
}
