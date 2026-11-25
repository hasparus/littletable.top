import { FileHelpers, type SvgExportContext } from "tldraw";

import type { TrackerLayout } from "../../src/gizmo-packages";
import type { TrackerSeat } from "./tracker-controls";

const materials = {
  wood: "#875735",
  metal: "#303530",
  channel: "#533724",
  brass: "#d5a966",
  paper: "#f6e7c7",
  ink: "#392719",
  label: "#ede4c8",
  graphite: "#292c28",
  track: "#181c19",
  cap: "#b4b9b0",
  portraitFrame: "#272423",
  frameEdge: "#797267",
  gold: "#f4c77e",
  vellum: "#eedfc8",
  arrow: "#e0bc80",
};

type TrackerArt = {
  seats: TrackerSeat[];
  active?: number;
  token?: string;
  portraits?: string[];
};

function embed(ctx: SvgExportContext, id: string, src: string, width: number, height: number) {
  ctx.addExportDef({
    key: id,
    getElement: async () => (
      <image id={id} href={await FileHelpers.urlToDataUrl(src)} width={width} height={height} />
    ),
  });
  return "#" + id;
}

export function exportTracker(
  ctx: SvgExportContext,
  key: string,
  layout: TrackerLayout,
  state: TrackerArt,
  size: { w: number; h: number },
  output: { w: number; h: number },
) {
  const { seats, active } = state;
  const rail = layout === "rail";
  const sliders = layout === "sliders";
  const activeIndex = seats.findIndex((seat) => seat.id === active);
  const start = layout === "initiative" ? Math.max(0, activeIndex - 7) : 0;
  const visible = rail ? seats : seats.slice(start, start + 8);
  const token = rail && state.token && embed(ctx, key, state.token, 39, 39);
  const cap = sliders && state.token && embed(ctx, key, state.token, 34, 18);
  const portraits = new Map<string, string>();
  return (
    <svg
      width={output.w}
      height={output.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      preserveAspectRatio="none"
    >
      <rect width={size.w} height={size.h} rx={9} fill={rail ? materials.wood : materials.metal} />
      {visible.map((seat, index) => {
        const activeSeat = seat.id === active;
        if (rail) {
          const row = (size.h - 38) / seats.length;
          const cy = 8 + row * (index + 0.5);
          return (
            <g key={seat.id}>
              <rect x={25} y={cy - row / 2} width={9} height={row} fill={materials.channel} />
              <circle cx={30} cy={cy} r={activeSeat ? 16 : 4} fill={materials.brass} />
              {activeSeat && token && <use href={token} x={10.5} y={cy - 19.5} />}
              <rect
                x={65}
                y={cy - row * 0.36}
                width={141}
                height={row * 0.72}
                rx={3}
                fill={materials.paper}
              />
              <text x={74} y={cy + 5} fill={materials.ink} fontFamily="Georgia,serif" fontSize={16}>
                {seat.name.slice(0, 16)}
              </text>
            </g>
          );
        }
        const x = 11 + index * (sliders ? 64 : 72);
        const cy = 153 - Math.min(100, Math.max(0, seat.marks)) * 1.02;
        if (sliders)
          return (
            <g key={seat.id} transform={`translate(${x} 0)`}>
              <rect x={3} y={11} width={57} height={24} rx={3} fill={materials.label} />
              <text x={31} y={27} textAnchor="middle" fontSize={11} fill={materials.graphite}>
                {seat.name.slice(0, 9)}
              </text>
              <rect x={29} y={44} width={5} height={119} rx={3} fill={materials.track} />
              <rect x={14} y={cy - 9} width={34} height={18} rx={3} fill={materials.cap} />
              {cap && <use href={cap} x={14} y={cy - 9} />}
              <text x={31} y={184} textAnchor="middle" fill={materials.label} fontSize={11}>
                {seat.marks}
              </text>
            </g>
          );
        const art = state.portraits?.[seat.id % state.portraits.length];
        if (art && !portraits.has(art))
          portraits.set(art, embed(ctx, key + "-" + portraits.size, art, 58, 69));
        return (
          <g key={seat.id} transform={`translate(${x} 0)`}>
            <rect
              y={10}
              width={64}
              height={76}
              rx={4}
              fill={materials.portraitFrame}
              stroke={activeSeat ? materials.gold : materials.frameEdge}
              strokeWidth={activeSeat ? 3 : 1}
            />
            {art && <use href={portraits.get(art)} x={3} y={13} />}
            <text x={32} y={102} textAnchor="middle" fill={materials.vellum} fontSize={11}>
              {seat.name.slice(0, 10)}
            </text>
          </g>
        );
      })}
      {layout === "initiative" && (
        <path
          d={`M${size.w - 45} 48l12 10-12 10`}
          fill="none"
          stroke={materials.arrow}
          strokeWidth={4}
        />
      )}
    </svg>
  );
}
