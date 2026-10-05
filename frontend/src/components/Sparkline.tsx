/* 7-to-14 point sparkline for a table row or stat tile. One series, 2px line in
   the de-emphasis ink, the latest point in the accent, an optional dashed
   reference (the accepted baseline). No axes: the row's numbers carry the
   values; the <title> carries them for hover and assistive tech. */

export function Sparkline({
  values,
  reference,
  width = 120,
  height = 28,
  title,
}: {
  values: number[];
  reference?: number | null;
  width?: number;
  height?: number;
  title?: string;
}) {
  if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const pad = 3;
  const all = reference != null ? [...values, reference] : values;
  const max = Math.max(...all, 0.01);
  const min = Math.min(...all, 0);
  const x = (i: number) => pad + (i * (width - 2 * pad)) / Math.max(values.length - 1, 1);
  const y = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {reference != null && (
        <line
          x1={pad}
          x2={width - pad}
          y1={y(reference)}
          y2={y(reference)}
          className="stroke-sdfc-chrome-light dark:stroke-sdfc-chrome-dark"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <polyline
        points={points}
        fill="none"
        className="stroke-sdfc-chrome-medium dark:stroke-sdfc-chrome"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={3} className="fill-sdfc-azul-bright dark:fill-[#3987e5]" />
    </svg>
  );
}
