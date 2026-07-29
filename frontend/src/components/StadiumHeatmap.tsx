import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
// MapLibre resolves its worker by URL relative to the page at runtime; in the
// built SPA that URL doesn't exist and the hosting rewrite answers with
// index.html (MIME error, blank map). Bundle the worker as its own Vite worker
// entry (it imports maplibre's shared chunk) and point the library at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import polylabel from 'polylabel';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(workerUrl);
// Static export of the Snapdragon Stadium section polygons. Source of truth:
// PMY-Group/sdfc-stadium-map (Ticketmaster placeDetail, venueConfigId 131357);
// regenerate there with build_stadium.py and re-copy — do not edit here.
import sectionsRaw from '@/assets/snapdragon_sections.json';
import type { StadiumSectionHeat } from '@/lib/api';

/* The geometry lives on a planar 10240×7680 Y-up page (no geographic CRS).
   MapLibre only speaks lng/lat, so we squeeze the page into a tiny box at the
   equator: 1° of longitude wide, where mercator distortion over 0.75° of
   latitude is negligible (<0.01%). Y is up in the source data and latitude is
   up on the map, so y maps to lat directly — no flip. */
const PAGE_W = 10240;
const PAGE_H = 7680;
const SCALE = 1 / PAGE_W;
const toLngLat = ([x, y]: number[]): [number, number] => [x * SCALE, y * SCALE];

const BOUNDS: [[number, number], [number, number]] = [
  [0, 0],
  [PAGE_W * SCALE, PAGE_H * SCALE],
];
const PADDED: [[number, number], [number, number]] = [
  [-0.18, -0.135],
  [PAGE_W * SCALE + 0.18, PAGE_H * SCALE + 0.135],
];

interface SectionFeature {
  type: 'Feature';
  id?: string | number;
  properties: { section: string; category: string; level: string; seats: number };
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
}

/* The export's nesting depth varies per feature (some "MultiPolygon" rows carry
   Polygon-shaped coordinates), so transform recursively: any [number, number]
   leaf becomes lng/lat, arrays recurse. */
type CoordTree = number[] | CoordTree[];
function transformCoords(c: CoordTree): CoordTree {
  return typeof c[0] === 'number'
    ? toLngLat(c as number[])
    : (c as CoordTree[]).map(transformCoords);
}

const transformed: FeatureCollection = (() => {
  const src = sectionsRaw as unknown as { features: SectionFeature[] };
  return {
    type: 'FeatureCollection',
    features: src.features.map((f) => ({
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: transformCoords(f.geometry.coordinates as unknown as CoordTree),
      },
    })),
  } as unknown as FeatureCollection;
})();

/* Soccer pitch overlay, sized off the section lines themselves: this is the
   largest 105:68 rounded rectangle that fits the bowl's interior, found by
   binary-searching the fit against the section polygons. It comes out flush
   against the west sideline stands (116–119) on the left and against the
   bottom edge of the PITCH 1 / PITCH 2 field boxes (y = 5104) on top — the
   "Home/Visitor Pitch Boxes" of the Ticketmaster map. Rounded corners follow
   the bowl's curve and buy ~4% over a hard-cornered rectangle. */
const FIELD_CX = 5035;
const FIELD_CY = 3765;
const FIELD_HW = 2058;
const FIELD_HH = 1332;
const FIELD_R = 333;

/* Page units per meter for the markings. The marked pitch is inset inside the
   grass to leave run-off: ~4.7 m behind each goal, ~3.0 m past each touchline. */
const PITCH_M = 36;
const PITCH_CX = FIELD_CX;
const PITCH_CY = FIELD_CY;

const GRASS_LIGHT = '#2e9d4c';
const GRASS_DARK = '#1f6f3a';
const PITCH_LINE_LIGHT = '#fcfcfb';
const PITCH_LINE_DARK = '#d7e2e8';

const pitchPoint = ([mx, my]: number[]): [number, number] =>
  toLngLat([PITCH_CX + mx * PITCH_M, PITCH_CY + my * PITCH_M]) as [number, number];

/* The grass is built in page units (it is sized off the sections, not off the
   pitch's metric grid), unlike the markings below which are laid out in meters
   about the pitch centre. */
function roundedField(): [number, number][] {
  const sw = FIELD_HW - FIELD_R;
  const sh = FIELD_HH - FIELD_R;
  const corners: [number, number, number][] = [
    [FIELD_CX + sw, FIELD_CY + sh, 0],
    [FIELD_CX - sw, FIELD_CY + sh, Math.PI / 2],
    [FIELD_CX - sw, FIELD_CY - sh, Math.PI],
    [FIELD_CX + sw, FIELD_CY - sh, Math.PI * 1.5],
  ];
  const pts: [number, number][] = [];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= 14; i++) {
      const a = a0 + (Math.PI / 2) * (i / 14);
      pts.push(
        toLngLat([ox + FIELD_R * Math.cos(a), oy + FIELD_R * Math.sin(a)]) as [number, number]
      );
    }
  }
  pts.push(pts[0]);
  return pts;
}

const PITCH = (() => {
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 48) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  const rect = (x1: number, y1: number, x2: number, y2: number) => [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ];
  // Penalty arc meets the area edge where cos(a) = (16.5 − 11) / 9.15
  const A = Math.acos(5.5 / 9.15);
  const lines: number[][][] = [
    rect(-52.5, -34, 52.5, 34), // touchlines + goal lines
    [
      [0, -34],
      [0, 34],
    ], // halfway line
    arc(0, 0, 9.15, 0, Math.PI * 2, 72), // center circle
    [
      [-52.5, -20.16],
      [-36, -20.16],
      [-36, 20.16],
      [-52.5, 20.16],
    ], // penalty areas
    [
      [52.5, -20.16],
      [36, -20.16],
      [36, 20.16],
      [52.5, 20.16],
    ],
    [
      [-52.5, -9.16],
      [-47, -9.16],
      [-47, 9.16],
      [-52.5, 9.16],
    ], // goal areas
    [
      [52.5, -9.16],
      [47, -9.16],
      [47, 9.16],
      [52.5, 9.16],
    ],
    arc(-41.5, 0, 9.15, -A, A), // penalty arcs
    arc(41.5, 0, 9.15, Math.PI - A, Math.PI + A),
    arc(-52.5, -34, 1, 0, Math.PI / 2, 8), // corner arcs
    arc(52.5, -34, 1, Math.PI / 2, Math.PI, 8),
    arc(52.5, 34, 1, Math.PI, Math.PI * 1.5, 8),
    arc(-52.5, 34, 1, Math.PI * 1.5, Math.PI * 2, 8),
    rect(-54.4, -3.66, -52.5, 3.66), // goal frames
    rect(52.5, -3.66, 54.4, 3.66),
  ];
  const feature = (geometry: object) => ({
    type: 'Feature',
    properties: {},
    geometry,
  });
  const fc = (features: object[]) =>
    ({ type: 'FeatureCollection', features }) as unknown as FeatureCollection;
  return {
    grass: fc([feature({ type: 'Polygon', coordinates: [roundedField()] })]),
    lines: fc(lines.map((c) => feature({ type: 'LineString', coordinates: c.map(pitchPoint) }))),
    spots: fc(
      [
        [0, 0],
        [-41.5, 0],
        [41.5, 0],
      ].map((p) => feature({ type: 'Point', coordinates: pitchPoint(p) }))
    ),
    tags: [
      { lngLat: pitchPoint([-22, 0]), label: 'HOME', cls: 'home' },
      { lngLat: pitchPoint([22, 0]), label: 'VISITOR', cls: 'visitor' },
    ],
  };
})();

function collectRings(c: CoordTree, out: number[][][]): void {
  if (Array.isArray(c[0]) && typeof (c[0] as number[])[0] === 'number') {
    out.push(c as number[][]);
    return;
  }
  for (const k of c as CoordTree[]) collectRings(k, out);
}

interface SectionGeom {
  /** Points on the section's top and bottom edges, at the section's
      horizontal centre — the code chip sits across the centre of the top
      edge, and a number callout hangs off `bottom`. */
  top: [number, number];
  bottom: [number, number];
  /** The number's anchor: the area centroid when it sits inside the shape
      with reasonable clearance — visual centring; polylabel's pole wanders
      to the roomiest corner of asymmetric shapes like the 334 ramp's flared
      foot — otherwise the pole of inaccessibility, which is always inside
      (8 of the 100 sections are multi-part, and a centroid of disjoint parts
      lands in the gap between them). */
  center: [number, number];
  /** Distance from `center` to the nearest boundary, in degrees — half the
      section's local thickness at the label point. */
  centerRDeg: number;
  /** Bounding-box extent in degrees. */
  wDeg: number;
  hDeg: number;
}

/* The section's horizontal centre, lifted onto the given edge at that x — so
   the chip sits across the centre of the top edge whatever the edge's shape.
   The previous widest-span-near-the-edge scan drifted off-centre on slanted
   tops (T134, 135) and, on a diagonal sliver like the 334 ramp, crossed the
   body far below the cap and planted the chip on the ramp's side. */
function edgeAnchor(
  rings: number[][][],
  xMin: number,
  xMax: number,
  yTop: number,
  yBot: number,
  side: 'top' | 'bottom'
): [number, number] {
  const mid = (xMin + xMax) / 2;
  const ys: number[] = [];
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (xi > mid !== xj > mid) ys.push(yi + ((mid - xi) / (xj - xi)) * (yj - yi));
    }
  }
  // A multi-part section can have no boundary at its centre x; fall back to
  // the bounding box so the chip still lands sensibly.
  const fallback = side === 'top' ? yTop : yBot;
  const edge = ys.length ? (side === 'top' ? Math.max(...ys) : Math.min(...ys)) : fallback;
  return toLngLat([mid, edge]) as [number, number];
}

/* Area centroid over all rings, |area|-weighted (seat sections have no holes
   worth speaking of, so unsigned weights are safe against winding). */
function centroidOf(rings: number[][][]): [number, number] {
  let A = 0;
  let X = 0;
  let Y = 0;
  for (const r of rings) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      const f = xj * yi - xi * yj;
      a += f;
      cx += (xi + xj) * f;
      cy += (yi + yj) * f;
    }
    if (!a) continue;
    const w = Math.abs(a / 2);
    A += w;
    X += (cx / (3 * a)) * w;
    Y += (cy / (3 * a)) * w;
  }
  return A ? [X / A, Y / A] : [rings[0][0][0], rings[0][0][1]];
}

/* Even-odd ray cast across every ring. */
function insideRings(p: [number, number], rings: number[][][]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > p[1] !== yj > p[1] && p[0] < xi + ((p[1] - yi) / (yj - yi)) * (xj - xi)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/* Distance from a point to the nearest boundary segment. */
function distToBoundary(p: [number, number], rings: number[][][]): number {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, ay] = r[j];
      const dx = r[i][0] - ax;
      const dy = r[i][1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]));
    }
  }
  return best;
}

const SECTION_GEOM: Record<string, SectionGeom> = (() => {
  const out: Record<string, SectionGeom> = {};
  const src = sectionsRaw as unknown as { features: SectionFeature[] };
  for (const f of src.features) {
    const rings: number[][][] = [];
    collectRings(f.geometry.coordinates as unknown as CoordTree, rings);
    let yTop = -Infinity;
    let yBot = Infinity;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (const r of rings) {
      for (const [x, y] of r) {
        if (y > yTop) yTop = y;
        if (y < yBot) yBot = y;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    if (!Number.isFinite(yTop)) continue;
    const top = edgeAnchor(rings, xMin, xMax, yTop, yBot, 'top');
    const bottom = edgeAnchor(rings, xMin, xMax, yTop, yBot, 'bottom');
    /* polylabel takes one polygon, so run it per ring and keep the roomiest —
       for a multi-part section that picks the largest piece rather than
       averaging the parts into the empty space between them. */
    let best: number[] | null = null;
    for (const ring of rings) {
      const p = polylabel([ring as [number, number][]], 1) as number[] & {
        distance: number;
      };
      if (!best || p.distance > (best as number[] & { distance: number }).distance) best = p;
    }
    if (!best) continue;
    const poleR = (best as number[] & { distance: number }).distance;
    /* Prefer the centroid for visual centring, but only when it is inside the
       shape and not squeezed against an edge — under 60% of the pole's
       clearance means the centroid sits in a thin part (crescents, sharp
       wedges) and the roomier pole is the better home for the number. */
    const centroid = centroidOf(rings);
    const centroidR = insideRings(centroid, rings) ? distToBoundary(centroid, rings) : 0;
    const useCentroid = centroidR >= poleR * 0.6;
    out[f.properties.section] = {
      top,
      bottom,
      center: toLngLat(useCentroid ? centroid : best) as [number, number],
      centerRDeg: (useCentroid ? centroidR : poleR) * SCALE,
      wDeg: (xMax - xMin) * SCALE,
      hDeg: (yTop - yBot) * SCALE,
    };
  }
  return out;
})();

/* Sequential single-hue ramps, generated in OKLCH (hue 45, monotone lightness)
   and validated with the dataviz palette checker: monotone L, ΔL ≥ 0.06/step,
   endpoint ≥ 2:1 against each mode's surface. Dark mode flips the anchor:
   low values recede into the navy, high values glow. */
const RAMP_LIGHT = ['#e7885d', '#d26e3e', '#bc541a', '#a33d00', '#8a2400'];
const RAMP_DARK = ['#903a03', '#a95023', '#c2673b', '#db7e52', '#f59569'];
const NO_DATA_LIGHT = '#d9dee3';
const NO_DATA_DARK = '#22384f';
const SURFACE_LIGHT = '#fcfcfb';
const SURFACE_DARK = '#061729';
const OUTLINE_LIGHT = '#fcfcfb';
const OUTLINE_DARK = '#0b2341';

/* Ten stepped buckets (0–9%, 10–19%, … 90–100%), colored by sampling the
   validated 5-stop ramp at each bucket's midpoint. */
const BUCKET_COUNT = 10;

function hexMix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return (
    '#' +
    pa
      .map((v, i) =>
        Math.round(v + (pb[i] - v) * t)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

function sampleRamp(ramp: string[], t: number): string {
  const pos = t * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  return hexMix(ramp[i], ramp[i + 1], pos - i);
}

function bucketColors(ramp: string[]): string[] {
  return Array.from({ length: BUCKET_COUNT }, (_, i) => sampleRamp(ramp, (i + 0.5) / BUCKET_COUNT));
}

const BUCKETS_LIGHT = bucketColors(RAMP_LIGHT);
const BUCKETS_DARK = bucketColors(RAMP_DARK);

/* Style expressions have no null literal, so "no data" rides as -1 via
   coalesce (feature-state is unset until the heat query lands). */
function fillExpression(buckets: string[], noData: string): maplibregl.ExpressionSpecification {
  const steps: (number | string)[] = [];
  for (let i = 1; i < buckets.length; i++) steps.push(i / buckets.length, buckets[i]);
  return [
    'case',
    ['<', ['coalesce', ['feature-state', 'value'], -1], 0],
    noData,
    ['step', ['coalesce', ['feature-state', 'value'], 0], buckets[0], ...steps],
  ] as unknown as maplibregl.ExpressionSpecification;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark'))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export interface HoverInfo {
  x: number;
  y: number;
  boxWidth: number;
  boxHeight: number;
  section: string;
  category: string;
  heat: StadiumSectionHeat | null;
}

interface Props {
  heat: StadiumSectionHeat[];
  /** Normalized 0..1 value per section name; null/absent = no data (grey). */
  values: Record<string, number | null>;
  /** Metric text carried in the section's chip after its code
      (e.g. "39%"). Return null to show the section code alone. */
  labelFor?: (r: StadiumSectionHeat) => string | null;
  onHover?: (info: HoverInfo | null) => void;
}

/* Labels grow with zoom, reaching the 24px cap at max zoom. Growing slower
   than the geometry means labels keep revealing as you zoom in rather than
   freezing at whatever fit at the default view. */
const LABEL_MIN_PX = 15;
const LABEL_MAX_PX = 24;
const LABEL_ZOOM_SPAN = 4;
/** The metric reads as secondary at a slightly smaller size. */
const METRIC_SCALE = 0.88;
/** The unit glyph ('%') shrinks further within the number span so the digits,
    not the unit, sit optically centred in the chip. */
const UNIT_SCALE = 0.72;

/* '93%' → ['93', '%']; '1,234' → ['1,234', '']. The unit renders in its own
   format span at UNIT_SCALE. */
function splitUnit(text: string): [string, string] {
  return text.endsWith('%') ? [text.slice(0, -1), '%'] : [text, ''];
}

/* Label size steps at whole zoom levels rather than interpolating.

   MapLibre builds a symbol's collision box on the worker at an integer zoom but
   renders the glyphs at the live fractional zoom, with no fractional
   compensation for point labels (maplibre-gl-js#5677, open; Mapbox fixed it in
   GL JS v2, past the fork). Interpolating 15->24px across four zoom levels
   therefore left the boxes disagreeing with the chips by up to 60% mid-zoom,
   and chips overlapped. Holding the size constant between whole zoom levels
   makes the two agree. The cost is a visible step in size at each level.

   Both the style expression and the JS fit test read this one function, so the
   size the renderer draws and the size the fit test assumes cannot drift. */
function labelFontPx(zoom: number, baseZoom: number, scale = 1): number {
  const step = Math.floor(Math.max(0, Math.min(LABEL_ZOOM_SPAN, zoom - baseZoom)));
  const t = step / LABEL_ZOOM_SPAN;
  return (LABEL_MIN_PX + (LABEL_MAX_PX - LABEL_MIN_PX) * t) * scale;
}

/* No `glyphs` URL is set on the style, so MapLibre treats text-font as a
   cascading list of local font names and rasterises glyphs itself — symbol
   layers with no glyph server and no font assets to ship. */
const LABEL_FONT = ['Inter Variable', 'Inter', 'Helvetica Neue', 'Arial'];

const CHIP_LIGHT = 'chip-light';
const CHIP_DARK = 'chip-dark';
/** The code chips' own image: light fill in both themes, tighter content box. */
const CHIP_CODE = 'chip-code';

/* The chip behind a label: a rounded rect drawn once and registered as a
   stretchable image, so `icon-text-fit` grows it around whatever text it
   carries. Corners sit outside the stretch bands so they never distort. */
const CHIP_PX = 32;
const CHIP_IMAGE_OPTIONS = {
  pixelRatio: 2,
  stretchX: [[14, 18]] as [number, number][],
  stretchY: [[14, 18]] as [number, number][],
  content: [8, 6, 24, 26] as [number, number, number, number],
};
/* The code chips run tighter: same rounded rect, roughly half the air around
   the text (2.5px / 1.5px CSS margins vs 4px / 3px). */
const CODE_CHIP_IMAGE_OPTIONS = {
  ...CHIP_IMAGE_OPTIONS,
  content: [5, 3, 27, 29] as [number, number, number, number],
};

function chipImage(fill: string, stroke: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = CHIP_PX;
  canvas.height = CHIP_PX;
  const ctx = canvas.getContext('2d')!;
  const lw = 2;
  const r = 8;
  const a = lw / 2;
  const b = CHIP_PX - lw / 2;
  ctx.beginPath();
  ctx.moveTo(a + r, a);
  ctx.arcTo(b, a, b, b, r);
  ctx.arcTo(b, b, a, b, r);
  ctx.arcTo(a, b, a, a, r);
  ctx.arcTo(a, a, b, a, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  return ctx.getImageData(0, 0, CHIP_PX, CHIP_PX);
}

/** Callout distance: how far below the section its label hangs, in pixels. */
const CALLOUT_PX = 30;
/* Clearance around each chip. `text-padding` pads only the text's own box —
   with icon-text-fit the fitted chip is a separate, larger collision box with
   its own `icon-padding`, so that is the knob that actually keeps chips apart. */
const CHIP_PADDING = 4;
const LEADER_LIGHT = '#8a9ba8';
const LEADER_DARK = '#6b7d8a';

const CHIP_FILL_LIGHT = '#fcfcfb';
const CHIP_STROKE_LIGHT = '#c9d1d8';
const CHIP_FILL_DARK = '#0b2341';
const CHIP_STROKE_DARK = '#35506e';
const LABEL_TEXT_LIGHT = '#1a1a19';
const LABEL_TEXT_DARK = '#e8ecf0';

export default function StadiumHeatmap({ heat, values, labelFor, onHover }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const baseZoomRef = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const dark = useIsDark();

  const heatBySection = useMemo(() => {
    const m: Record<string, StadiumSectionHeat> = {};
    for (const r of heat) m[r.section] = r;
    return m;
  }, [heat]);
  const heatRef = useRef(heatBySection);
  heatRef.current = heatBySection;

  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = document.documentElement.classList.contains('dark');
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'bg',
            type: 'background',
            paint: { 'background-color': isDark ? SURFACE_DARK : SURFACE_LIGHT },
          },
        ],
      },
      bounds: BOUNDS,
      fitBoundsOptions: { padding: 24 },
      maxBounds: PADDED,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;

    map.on('load', () => {
      baseZoomRef.current = map.getZoom();
      map.setMaxZoom(map.getZoom() + LABEL_ZOOM_SPAN);
      map.setMinZoom(map.getZoom() - 0.4);

      const d = document.documentElement.classList.contains('dark');

      /* Pitch first so sections (non-overlapping anyway) draw above it. */
      map.addSource('pitch-grass', { type: 'geojson', data: PITCH.grass });
      map.addLayer({
        id: 'pitch-grass',
        type: 'fill',
        source: 'pitch-grass',
        paint: { 'fill-color': d ? GRASS_DARK : GRASS_LIGHT },
      });
      map.addSource('pitch-lines', { type: 'geojson', data: PITCH.lines });
      map.addLayer({
        id: 'pitch-lines',
        type: 'line',
        source: 'pitch-lines',
        paint: {
          'line-color': d ? PITCH_LINE_DARK : PITCH_LINE_LIGHT,
          'line-width': 1,
          'line-opacity': 0.9,
        },
      });
      map.addSource('pitch-spots', { type: 'geojson', data: PITCH.spots });
      map.addLayer({
        id: 'pitch-spots',
        type: 'circle',
        source: 'pitch-spots',
        paint: {
          'circle-radius': 2,
          'circle-color': d ? PITCH_LINE_DARK : PITCH_LINE_LIGHT,
          'circle-opacity': 0.9,
        },
      });
      for (const tag of PITCH.tags) {
        const el = document.createElement('div');
        el.className = `stadium-pitch-tag ${tag.cls}`;
        el.textContent = tag.label;
        el.style.pointerEvents = 'none';
        new maplibregl.Marker({ element: el }).setLngLat(tag.lngLat).addTo(map);
      }

      map.addSource('sections', {
        type: 'geojson',
        data: transformed,
        promoteId: 'section',
      });
      map.addLayer({
        id: 'section-fill',
        type: 'fill',
        source: 'sections',
        paint: {
          'fill-color': fillExpression(
            d ? BUCKETS_DARK : BUCKETS_LIGHT,
            d ? NO_DATA_DARK : NO_DATA_LIGHT
          ),
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.82, 1],
        },
      });
      map.addLayer({
        id: 'section-outline',
        type: 'line',
        source: 'sections',
        paint: {
          'line-color': d ? OUTLINE_DARK : OUTLINE_LIGHT,
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 0.75],
        },
      });

      /* Section labels as symbol layers, so MapLibre owns collision, priority
         and zoom sizing rather than us measuring DOM nodes every frame.

         Whether a number sits at its centre or drops to a callout is ours to
         decide in the sync effect below — collision can only see other
         labels, not the section shapes. `symbol-sort-key` carries the seat
         count negated, so the biggest sections place first.

         Deferred until the webfont resolves: MapLibre rasterises local glyphs
         on first use and caches them, so adding these before Inter has loaded
         would bake a fallback face into the atlas. */
      void document.fonts.ready.then(() => {
        if (!mapRef.current) return;
        const emptyFC = { type: 'FeatureCollection' as const, features: [] };
        /* Stops land on whole zoom levels — the zooms MapLibre builds its
           collision boxes at — so the rendered size never disagrees with the
           box. See labelFontPx. */
        const textSize = (scale: number): maplibregl.ExpressionSpecification => {
          const b = baseZoomRef.current ?? map.getZoom();
          const stops: number[] = [];
          for (let z = Math.ceil(b); z <= b + LABEL_ZOOM_SPAN; z++) {
            stops.push(z, labelFontPx(z, b, scale));
          }
          return [
            'step',
            ['zoom'],
            labelFontPx(b, b, scale),
            ...stops,
          ] as unknown as maplibregl.ExpressionSpecification;
        };

        map.addImage(CHIP_LIGHT, chipImage(CHIP_FILL_LIGHT, CHIP_STROKE_LIGHT), CHIP_IMAGE_OPTIONS);
        map.addImage(CHIP_DARK, chipImage(CHIP_FILL_DARK, CHIP_STROKE_DARK), CHIP_IMAGE_OPTIONS);
        map.addImage(
          CHIP_CODE,
          chipImage(CHIP_FILL_LIGHT, CHIP_STROKE_LIGHT),
          CODE_CHIP_IMAGE_OPTIONS
        );
        const chip = d ? CHIP_DARK : CHIP_LIGHT;
        const ink = d ? LABEL_TEXT_DARK : LABEL_TEXT_LIGHT;

        /* Leader lines. MapLibre has no leader/callout property, so this is the
           documented shape: a point source for the label plus a secondary line
           layer joining it back to the feature. Added before the symbol layers
           so the chips paint over the stem. */
        map.addSource('label-leaders', { type: 'geojson', data: emptyFC });
        map.addLayer({
          id: 'label-leader',
          type: 'line',
          source: 'label-leaders',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': d ? LEADER_DARK : LEADER_LIGHT,
            'line-width': 1.25,
          },
        });

        /* Codes and numbers are separate layers with separate jobs:

           - `code-label`: the section name, ALWAYS above the section's top
             edge, on a fixed white chip with near-black ink in both themes —
             it reads as a tag on the stadium furniture, not as a datum.
           - `metric-label` (topmost, places first): the number, centred on
             the section's visual centre, or hung below the section
             on a leader-line callout where the shape cannot hold even the
             mini chip. Numbers place first, so in a crowd it is a code that
             yields, never a number.

           The unit ('%') renders at a further reduced font-scale so the
           digits, not the unit, sit optically centred — the engine cannot
           exclude a glyph from line centring. */
        map.addSource('code-labels', { type: 'geojson', data: emptyFC });
        map.addLayer({
          id: 'code-label',
          type: 'symbol',
          source: 'code-labels',
          layout: {
            'text-field': ['get', 'code'],
            'text-font': LABEL_FONT,
            // A quarter smaller than the metrics' base scale: the name is
            // wayfinding, not data, so it cedes visual rank to the numbers.
            'text-size': textSize(0.75),
            'text-anchor': 'bottom',
            'text-offset': [0, -0.15],
            'text-padding': 2,
            'symbol-sort-key': ['get', 'sortKey'],
            'icon-image': CHIP_CODE,
            'icon-text-fit': 'both',
            // The chip, not the text, is the shape that visually collides, and it
            // has its own padding knob — text-padding does not apply to it.
            'icon-padding': CHIP_PADDING,
          },
          paint: { 'text-color': LABEL_TEXT_LIGHT },
        });

        map.addSource('metric-labels', { type: 'geojson', data: emptyFC });
        map.addLayer({
          id: 'metric-label',
          type: 'symbol',
          source: 'metric-labels',
          layout: {
            'text-field': [
              'format',
              ['get', 'digits'],
              {},
              ['get', 'unit'],
              { 'font-scale': UNIT_SCALE },
            ],
            'text-font': LABEL_FONT,
            'text-size': textSize(METRIC_SCALE),
            'text-anchor': 'center',
            'text-padding': 2,
            'symbol-sort-key': ['get', 'sortKey'],
            'icon-image': chip,
            'icon-text-fit': 'both',
            'icon-padding': CHIP_PADDING,
          },
          paint: { 'text-color': ink },
        });
        setLoaded(true);
      });

      let hovered: string | number | null = null;
      map.on('mousemove', 'section-fill', (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        if (hovered !== null && hovered !== f.id) {
          map.setFeatureState({ source: 'sections', id: hovered }, { hover: false });
        }
        hovered = f.id ?? null;
        if (hovered !== null) {
          map.setFeatureState({ source: 'sections', id: hovered }, { hover: true });
        }
        map.getCanvas().style.cursor = 'pointer';
        const props = f.properties as { section: string; category: string };
        const canvas = map.getCanvas();
        onHover?.({
          x: e.point.x,
          y: e.point.y,
          boxWidth: canvas.clientWidth,
          boxHeight: canvas.clientHeight,
          section: props.section,
          category: props.category,
          heat: heatRef.current[props.section] ?? null,
        });
      });
      map.on('mouseleave', 'section-fill', () => {
        if (hovered !== null) {
          map.setFeatureState({ source: 'sections', id: hovered }, { hover: false });
          hovered = null;
        }
        map.getCanvas().style.cursor = '';
        onHover?.(null);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The map instance lives for the component's lifetime; theme/data changes
    // are applied by the effects below rather than by re-creating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Feed the label layers: every section's code chip rides above its top
     edge, and its number — where there is one — sits at the section's
     visual centre, dropping to a leader-line callout below the section
     when the shape cannot hold even the mini chip.

     Section size depends on zoom (and on the container, hence the resize
     listener), so this reruns as the view changes — but it only touches the
     sources when a section actually changes state, which happens a handful of
     times across the whole zoom range rather than every frame. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    let lastSignature = '';
    const sync = () => {
      const base = baseZoomRef.current ?? map.getZoom();
      const font = labelFontPx(map.getZoom(), base);
      // The mini number chip's height, mirroring its em-based padding so the
      // box scales with the font.
      const miniH = font * METRIC_SCALE * 1.3 + 2;
      // The extent is tiny and unrotated, so one linear scale covers the map.
      const origin = map.project([0, 0]);
      const pxPerLat = origin.y - map.project([0, 1]).y;

      const codes: GeoJSON.Feature[] = [];
      const metrics: GeoJSON.Feature[] = [];
      const leaders: GeoJSON.Feature[] = [];
      /* A callout hangs a fixed pixel distance off the section, so its point
         moves in geographic terms as the scale changes. Quantising the scale
         keeps that to a handful of rebuilds across the zoom range instead of
         one per frame; a step of 2^0.1 (~7% offset error) is not visible.
         Keyed on pxPerLat rather than zoom so a container resize — which
         changes the scale at constant zoom — also lands a rebuild. */
      const signature: string[] = [`s${Math.round(Math.log2(pxPerLat) * 10)}`];
      for (const r of heat) {
        if (r.cx == null || r.cy == null) continue;
        // Negated so the biggest sections carry the lowest key and place first.
        const sortKey = -(r.total_seats ?? 0);
        const geom = SECTION_GEOM[r.section];
        // Centroid when it sits inside with clearance, else the pole — see
        // SECTION_GEOM. Either way the number lands inside the shape.
        const anchor = geom ? geom.center : (toLngLat([r.cx, r.cy]) as [number, number]);
        const rPx = (geom?.centerRDeg ?? 0) * pxPerLat;
        const secH = (geom?.hDeg ?? 0) * pxPerLat;

        const metricText = labelFor
          ? labelFor(r)
          : r.pct_sold == null
            ? null
            : `${Math.round(r.pct_sold * 100)}%`;

        codes.push({
          type: 'Feature',
          properties: { code: r.data_code, sortKey },
          geometry: { type: 'Point', coordinates: geom?.top ?? anchor },
        });
        if (!metricText) {
          signature.push('x');
          continue;
        }

        /* Centre or callout, judged on height and thickness only — numbers are
           short, so width almost never binds, and a width criterion pushed
           narrow-but-roomy strips into needless callouts. The inscribed
           radius keeps multi-part and sliver shapes honest: PIERS spans
           237x350px across three disjoint pieces but is only 44px thick, and
           a box test alone would drop its number in the gap between them. */
        const [digits, unit] = splitUnit(metricText);
        const fitsPole = secH >= miniH && 2 * rPx >= miniH;
        signature.push(fitsPole ? 'p' : 'c');
        if (fitsPole) {
          metrics.push({
            type: 'Feature',
            properties: { digits, unit, sortKey },
            geometry: { type: 'Point', coordinates: anchor },
          });
        } else if (geom) {
          const [ax, ay] = geom.bottom;
          const point: [number, number] = [ax, ay - CALLOUT_PX / pxPerLat];
          metrics.push({
            type: 'Feature',
            properties: { digits, unit, sortKey },
            geometry: { type: 'Point', coordinates: point },
          });
          leaders.push({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: [geom.bottom, point] },
          });
        }
      }

      const next = signature.join('');
      if (next === lastSignature) return;
      lastSignature = next;
      const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      src('code-labels')?.setData({ type: 'FeatureCollection', features: codes });
      src('metric-labels')?.setData({ type: 'FeatureCollection', features: metrics });
      src('label-leaders')?.setData({
        type: 'FeatureCollection',
        features: leaders,
      });
    };

    sync();
    map.on('zoom', sync);
    // pxPerLat also changes when the container does (sidebar toggle, window
    // resize) with no zoom event, and stale fit tests linger until the next.
    map.on('resize', sync);
    return () => {
      map.off('zoom', sync);
      map.off('resize', sync);
    };
  }, [heat, labelFor, loaded]);

  /* Push metric values into feature state (null = grey no-data). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const f of transformed.features) {
      const section = (f.properties as { section: string }).section;
      map.setFeatureState({ source: 'sections', id: section }, { value: values[section] ?? -1 });
    }
  }, [values, loaded]);

  /* Theme swap without map re-creation. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setPaintProperty('bg', 'background-color', dark ? SURFACE_DARK : SURFACE_LIGHT);
    map.setPaintProperty(
      'section-fill',
      'fill-color',
      fillExpression(dark ? BUCKETS_DARK : BUCKETS_LIGHT, dark ? NO_DATA_DARK : NO_DATA_LIGHT)
    );
    map.setPaintProperty('section-outline', 'line-color', dark ? OUTLINE_DARK : OUTLINE_LIGHT);
    map.setPaintProperty('pitch-grass', 'fill-color', dark ? GRASS_DARK : GRASS_LIGHT);
    map.setPaintProperty('pitch-lines', 'line-color', dark ? PITCH_LINE_DARK : PITCH_LINE_LIGHT);
    map.setPaintProperty('pitch-spots', 'circle-color', dark ? PITCH_LINE_DARK : PITCH_LINE_LIGHT);
    // The code chips are deliberately theme-invariant (white chip, dark ink).
    map.setPaintProperty('metric-label', 'text-color', dark ? LABEL_TEXT_DARK : LABEL_TEXT_LIGHT);
    map.setLayoutProperty('metric-label', 'icon-image', dark ? CHIP_DARK : CHIP_LIGHT);
    map.setPaintProperty('label-leader', 'line-color', dark ? LEADER_DARK : LEADER_LIGHT);
  }, [dark, loaded]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export { BUCKETS_LIGHT, BUCKETS_DARK, NO_DATA_LIGHT, NO_DATA_DARK };
