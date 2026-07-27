import { useEffect, useMemo, useRef, useState } from "react"
import * as maplibregl from "maplibre-gl"
// MapLibre resolves its worker by URL relative to the page at runtime; in the
// built SPA that URL doesn't exist and the hosting rewrite answers with
// index.html (MIME error, blank map). Bundle the worker as its own Vite worker
// entry (it imports maplibre's shared chunk) and point the library at it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import type { FeatureCollection } from "geojson"
import "maplibre-gl/dist/maplibre-gl.css"

maplibregl.setWorkerUrl(workerUrl)
// Static export of the Snapdragon Stadium section polygons. Source of truth:
// PMY-Group/sdfc-stadium-map (Ticketmaster placeDetail, venueConfigId 131357);
// regenerate there with build_stadium.py and re-copy — do not edit here.
import sectionsRaw from "@/assets/snapdragon_sections.json"
import type { StadiumSectionHeat } from "@/lib/api"

/* The geometry lives on a planar 10240×7680 Y-up page (no geographic CRS).
   MapLibre only speaks lng/lat, so we squeeze the page into a tiny box at the
   equator: 1° of longitude wide, where mercator distortion over 0.75° of
   latitude is negligible (<0.01%). Y is up in the source data and latitude is
   up on the map, so y maps to lat directly — no flip. */
const PAGE_W = 10240
const PAGE_H = 7680
const SCALE = 1 / PAGE_W
const toLngLat = ([x, y]: number[]): [number, number] => [x * SCALE, y * SCALE]

const BOUNDS: [[number, number], [number, number]] = [
  [0, 0],
  [PAGE_W * SCALE, PAGE_H * SCALE],
]
const PADDED: [[number, number], [number, number]] = [
  [-0.18, -0.135],
  [PAGE_W * SCALE + 0.18, PAGE_H * SCALE + 0.135],
]

interface SectionFeature {
  type: "Feature"
  id?: string | number
  properties: { section: string; category: string; level: string; seats: number }
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] }
}

/* The export's nesting depth varies per feature (some "MultiPolygon" rows carry
   Polygon-shaped coordinates), so transform recursively: any [number, number]
   leaf becomes lng/lat, arrays recurse. */
type CoordTree = number[] | CoordTree[]
function transformCoords(c: CoordTree): CoordTree {
  return typeof c[0] === "number" ? toLngLat(c as number[]) : (c as CoordTree[]).map(transformCoords)
}

const transformed: FeatureCollection = (() => {
  const src = sectionsRaw as unknown as { features: SectionFeature[] }
  return {
    type: "FeatureCollection",
    features: src.features.map((f) => ({
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: transformCoords(f.geometry.coordinates as unknown as CoordTree),
      },
    })),
  } as unknown as FeatureCollection
})()

/* Sequential single-hue ramps, generated in OKLCH (hue 45, monotone lightness)
   and validated with the dataviz palette checker: monotone L, ΔL ≥ 0.06/step,
   endpoint ≥ 2:1 against each mode's surface. Dark mode flips the anchor:
   low values recede into the navy, high values glow. */
const RAMP_LIGHT = ["#e7885d", "#d26e3e", "#bc541a", "#a33d00", "#8a2400"]
const RAMP_DARK = ["#903a03", "#a95023", "#c2673b", "#db7e52", "#f59569"]
const NO_DATA_LIGHT = "#d9dee3"
const NO_DATA_DARK = "#22384f"
const SURFACE_LIGHT = "#fcfcfb"
const SURFACE_DARK = "#061729"
const OUTLINE_LIGHT = "#fcfcfb"
const OUTLINE_DARK = "#0b2341"

/* Ten stepped buckets (0–9%, 10–19%, … 90–100%), colored by sampling the
   validated 5-stop ramp at each bucket's midpoint. */
const BUCKET_COUNT = 10

function hexMix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return (
    "#" +
    pa
      .map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0"))
      .join("")
  )
}

function sampleRamp(ramp: string[], t: number): string {
  const pos = t * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(pos))
  return hexMix(ramp[i], ramp[i + 1], pos - i)
}

function bucketColors(ramp: string[]): string[] {
  return Array.from({ length: BUCKET_COUNT }, (_, i) =>
    sampleRamp(ramp, (i + 0.5) / BUCKET_COUNT),
  )
}

const BUCKETS_LIGHT = bucketColors(RAMP_LIGHT)
const BUCKETS_DARK = bucketColors(RAMP_DARK)

/* Style expressions have no null literal, so "no data" rides as -1 via
   coalesce (feature-state is unset until the heat query lands). */
function fillExpression(buckets: string[], noData: string): maplibregl.ExpressionSpecification {
  const steps: (number | string)[] = []
  for (let i = 1; i < buckets.length; i++) steps.push(i / buckets.length, buckets[i])
  return [
    "case",
    ["<", ["coalesce", ["feature-state", "value"], -1], 0],
    noData,
    ["step", ["coalesce", ["feature-state", "value"], 0], buckets[0], ...steps],
  ] as unknown as maplibregl.ExpressionSpecification
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    )
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return dark
}

export interface HoverInfo {
  x: number
  y: number
  boxWidth: number
  boxHeight: number
  section: string
  category: string
  heat: StadiumSectionHeat | null
}

interface Props {
  heat: StadiumSectionHeat[]
  /** Normalized 0..1 value per section name; null/absent = no data (grey). */
  values: Record<string, number | null>
  onHover?: (info: HoverInfo | null) => void
}

interface LabelEntry {
  marker: maplibregl.Marker
  lngLat: [number, number]
  seats: number
  width: number
  height: number
}

export default function StadiumHeatmap({ heat, values, onHover }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<LabelEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const dark = useIsDark()

  const heatBySection = useMemo(() => {
    const m: Record<string, StadiumSectionHeat> = {}
    for (const r of heat) m[r.section] = r
    return m
  }, [heat])
  const heatRef = useRef(heatBySection)
  heatRef.current = heatBySection

  useEffect(() => {
    if (!containerRef.current) return
    const isDark = document.documentElement.classList.contains("dark")
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "bg",
            type: "background",
            paint: { "background-color": isDark ? SURFACE_DARK : SURFACE_LIGHT },
          },
        ],
      },
      bounds: BOUNDS,
      fitBoundsOptions: { padding: 24 },
      maxBounds: PADDED,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    mapRef.current = map

    map.on("load", () => {
      map.setMaxZoom(map.getZoom() + 4)
      map.setMinZoom(map.getZoom() - 0.4)

      map.addSource("sections", {
        type: "geojson",
        data: transformed,
        promoteId: "section",
      })
      const d = document.documentElement.classList.contains("dark")
      map.addLayer({
        id: "section-fill",
        type: "fill",
        source: "sections",
        paint: {
          "fill-color": fillExpression(d ? BUCKETS_DARK : BUCKETS_LIGHT, d ? NO_DATA_DARK : NO_DATA_LIGHT),
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.82, 1],
        },
      })
      map.addLayer({
        id: "section-outline",
        type: "line",
        source: "sections",
        paint: {
          "line-color": d ? OUTLINE_DARK : OUTLINE_LIGHT,
          "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 0.75],
        },
      })

      let hovered: string | number | null = null
      map.on("mousemove", "section-fill", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0]
        if (!f) return
        if (hovered !== null && hovered !== f.id) {
          map.setFeatureState({ source: "sections", id: hovered }, { hover: false })
        }
        hovered = f.id ?? null
        if (hovered !== null) {
          map.setFeatureState({ source: "sections", id: hovered }, { hover: true })
        }
        map.getCanvas().style.cursor = "pointer"
        const props = f.properties as { section: string; category: string }
        const canvas = map.getCanvas()
        onHover?.({
          x: e.point.x,
          y: e.point.y,
          boxWidth: canvas.clientWidth,
          boxHeight: canvas.clientHeight,
          section: props.section,
          category: props.category,
          heat: heatRef.current[props.section] ?? null,
        })
      })
      map.on("mouseleave", "section-fill", () => {
        if (hovered !== null) {
          map.setFeatureState({ source: "sections", id: hovered }, { hover: false })
          hovered = null
        }
        map.getCanvas().style.cursor = ""
        onHover?.(null)
      })

      setLoaded(true)
    })

    return () => {
      markersRef.current.forEach((m) => m.marker.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
    // The map instance lives for the component's lifetime; theme/data changes
    // are applied by the effects below rather than by re-creating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Section labels: HTML markers at the BQ centroids (Y-up, same plane as the
     polygons) showing the section code with % sold beneath. Symbol layers need
     remote glyph PBFs; markers keep the page self-contained — so collision is
     ours to handle: on every settle, greedily keep labels big-sections-first
     and hide any whose estimated box overlaps one already placed. */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    markersRef.current.forEach((m) => m.marker.remove())
    markersRef.current = heat
      .filter((r) => r.cx != null && r.cy != null)
      .map((r) => {
        const el = document.createElement("div")
        el.className = "stadium-section-label"
        el.style.pointerEvents = "none"
        const code = document.createElement("div")
        code.textContent = r.data_code
        el.appendChild(code)
        let lines = 1
        let widest = r.data_code.length
        if (r.pct_sold != null) {
          const pct = document.createElement("div")
          pct.className = "pct"
          pct.textContent = `${Math.round(r.pct_sold * 100)}%`
          el.appendChild(pct)
          lines = 2
          widest = Math.max(widest, pct.textContent.length)
        }
        const lngLat = toLngLat([r.cx!, r.cy!]) as [number, number]
        return {
          marker: new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map),
          lngLat,
          seats: r.total_seats ?? 0,
          width: widest * 6.5 + 6,
          height: lines * 12 + 4,
        }
      })

    const sync = () => {
      const placed: { x1: number; y1: number; x2: number; y2: number }[] = []
      const bySize = [...markersRef.current].sort((a, b) => b.seats - a.seats)
      for (const entry of bySize) {
        const p = map.project(entry.lngLat)
        const box = {
          x1: p.x - entry.width / 2,
          y1: p.y - entry.height / 2,
          x2: p.x + entry.width / 2,
          y2: p.y + entry.height / 2,
        }
        const collides = placed.some(
          (o) => box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1,
        )
        entry.marker.getElement().style.display = collides ? "none" : ""
        if (!collides) placed.push(box)
      }
    }
    sync()
    map.on("moveend", sync)
    return () => {
      map.off("moveend", sync)
    }
  }, [heat, loaded])

  /* Push metric values into feature state (null = grey no-data). */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    for (const f of transformed.features) {
      const section = (f.properties as { section: string }).section
      map.setFeatureState(
        { source: "sections", id: section },
        { value: values[section] ?? -1 },
      )
    }
  }, [values, loaded])

  /* Theme swap without map re-creation. */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.setPaintProperty("bg", "background-color", dark ? SURFACE_DARK : SURFACE_LIGHT)
    map.setPaintProperty(
      "section-fill",
      "fill-color",
      fillExpression(dark ? BUCKETS_DARK : BUCKETS_LIGHT, dark ? NO_DATA_DARK : NO_DATA_LIGHT),
    )
    map.setPaintProperty("section-outline", "line-color", dark ? OUTLINE_DARK : OUTLINE_LIGHT)
  }, [dark, loaded])

  return <div ref={containerRef} className="h-full w-full" />
}

export { BUCKETS_LIGHT, BUCKETS_DARK, NO_DATA_LIGHT, NO_DATA_DARK }
