import type { TLArrowShape } from "@tldraw/tlschema";

export type ArrowTerminal = "end" | "start";
type Point = { x: number; y: number };

const keys = { end: "littleTableArrowEnd", start: "littleTableArrowStart" } as const;

export function savedArrowEndpoint(
  meta: TLArrowShape["meta"],
  terminal: ArrowTerminal,
): Point | undefined {
  const value = meta[keys[terminal]];
  if (typeof value !== "object" || value === null || !("x" in value) || !("y" in value)) return;
  const { x, y } = value;
  if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
    return { x, y };
  }
}

export function saveArrowEndpoints(
  arrow: TLArrowShape,
  endpoints: Partial<Record<ArrowTerminal, Point>>,
): TLArrowShape["meta"] | null {
  const meta = { ...arrow.meta };
  let changed = false;
  for (const terminal of ["start", "end"] as const) {
    const point = endpoints[terminal];
    if (point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const before = savedArrowEndpoint(meta, terminal);
    if (before?.x === point.x && before.y === point.y) continue;
    meta[keys[terminal]] = { x: point.x, y: point.y };
    changed = true;
  }
  return changed ? meta : null;
}
