import { T } from "@tldraw/validate";
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- ShapeUtil is the tldraw extension API this piece implements. */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  createShapeId,
  type Editor,
  FileHelpers,
  GeoShapeUtil,
  HTMLContainer,
  type SvgExportContext,
  type TLGeoShape,
  type TLShapeId,
  useValue,
} from "tldraw";

import { type InstalledGizmo, isGizmoAssetUrl } from "../../src/gizmo-packages";
import { fill } from "./copy";
import { playGizmoBurst } from "./gizmo-burst";
import { playGizmoCue, springGizmo } from "./gizmo-feedback";
import { useInstalledGizmo } from "./gizmo-installed";
import { useGizmoUi } from "./gizmo-ui";
import "./gizmo-geo.css";

const palette = {
  edge: "#322c20",
  enamel: "#253d39",
  bezel: "#6b6850",
  rim: "#617368",
  shadow: "#192a24",
  paper: "#e7d6a9",
  rest: "#354e47",
  pin: "#645335",
  pinMuted: "#a89972",
  ink: "#352d20",
  light: "#eee4ca",
  count: "#665634",
  countMuted: "#d4c7ac",
};
const WIDTH = 260;
const ROW = 42;
const MAX_SEATS = 24;

const common = {
  version: T.literal(1),
  url: T.string,
  name: T.object({ en: T.string, pl: T.string }),
  preview: T.string,
};
const tracker = T.object({
  ...common,
  kind: T.literal("tracker"),
  seats: T.arrayOf(T.object({ id: T.integer, name: T.string, marks: T.integer })),
});
const button = T.object({ ...common, kind: T.literal("button"), hits: T.integer });
type Tracker = T.TypeOf<typeof tracker>;
type Actuator = T.TypeOf<typeof button>;

const heightFor = (count: number) => Math.max(116, count * ROW + 32);

function readPiece(shape: TLGeoShape) {
  const value = shape.meta.gizmo;
  if (button.isValid(value) && isGizmoAssetUrl(value.preview)) return value;
  if (
    tracker.isValid(value) &&
    value.seats.length > 0 &&
    value.seats.length <= MAX_SEATS &&
    isGizmoAssetUrl(value.preview)
  )
    return value;
  return null;
}

export function placeGizmoGeo(
  editor: Editor,
  point: { x: number; y: number },
  piece: InstalledGizmo,
  names: readonly string[],
  locale: string,
) {
  const { kind, name, preview, width, height } = piece.manifest;
  if (editor.getIsReadonly() || kind === "deck" || !isGizmoAssetUrl(preview)) return false;
  const seats = names.slice(0, MAX_SEATS).map((name, id) => ({ id, name, marks: 0 }));
  if (seats.length === 0)
    seats.push({ id: 0, name: locale === "pl" ? "Gracz" : "Player", marks: 0 });
  const initial =
    kind === "tracker"
      ? { version: 1, kind, name, preview, url: piece.url, seats }
      : { version: 1, kind, name, preview, url: piece.url, hits: 0 };
  const id = createShapeId();
  const w = width / editor.getZoomLevel();
  const h =
    kind === "tracker"
      ? ((height / editor.getZoomLevel()) * heightFor(seats.length)) / heightFor(2)
      : height / editor.getZoomLevel();
  editor.markHistoryStoppingPoint();
  editor.createShape({
    id,
    type: "geo",
    x: point.x - w / 2,
    y: point.y - h / 2,
    props: { w, h, fill: "solid", geo: "rectangle" },
    meta: { gizmo: initial },
  });
  editor.select(id);
  return true;
}

function updateSeats(
  editor: Editor,
  id: TLShapeId,
  update: (seats: Tracker["seats"]) => Tracker["seats"],
) {
  const shape = editor.getShape(id);
  if (
    !shape ||
    !editor.isShapeOfType<TLGeoShape>(shape, "geo") ||
    editor.getIsReadonly() ||
    editor.isShapeOrAncestorLocked(shape)
  )
    return;
  const current = readPiece(shape);
  if (current?.kind !== "tracker") return;
  const seats = update(current.seats);
  if (seats === current.seats) return;
  editor.markHistoryStoppingPoint();
  editor.updateShape<TLGeoShape>({
    id,
    type: "geo",
    meta: { ...shape.meta, gizmo: { ...current, seats } },
    props: { h: (shape.props.h * heightFor(seats.length)) / heightFor(current.seats.length) },
  });
  return true;
}

function markSeat(editor: Editor, id: TLShapeId, seatId: number) {
  const changed = updateSeats(editor, id, (seats) => {
    const seat = seats.find(({ id }) => id === seatId);
    if (!seat) return seats;
    return [...seats.filter(({ id }) => id !== seatId), { ...seat, marks: seat.marks + 1 }];
  });
  if (changed) playGizmoCue("pass");
}

function joinTracker(editor: Editor, id: TLShapeId, name: string) {
  updateSeats(editor, id, (seats) => {
    if (seats.length >= MAX_SEATS || seats.some((seat) => seat.name === name)) return seats;
    const nextId = Math.max(...seats.map((seat) => seat.id)) + 1;
    return [...seats, { id: nextId, name, marks: 0 }];
  });
}

function TrackerFace({
  seats,
  preview,
  exportId,
}: {
  seats: Tracker["seats"];
  preview: string;
  exportId?: string;
}) {
  const height = heightFor(seats.length);
  const center = height / 2;
  const firstY = (height - seats.length * ROW) / 2;
  const marks = seats.reduce((total, seat) => total + seat.marks, 0);
  const token = useRef<SVGGElement>(null);
  const lastMarks = useRef(marks);
  useEffect(() => {
    const previous = lastMarks.current;
    lastMarks.current = marks;
    if (marks <= previous || token.current === null) return;
    return springGizmo(
      token.current,
      (t) => `translateY(${-11 * t}px) rotate(${14 * t}deg) scale(${1 + 0.05 * t})`,
    );
  }, [marks]);
  return (
    <>
      <rect width={WIDTH} height={height} rx={16} fill={palette.edge} />
      <rect
        x={1.5}
        y={1.5}
        width={WIDTH - 3}
        height={height - 6}
        rx={14}
        fill={palette.enamel}
        stroke={palette.bezel}
        strokeWidth={2}
      />
      <rect
        x={6}
        y={6}
        width={WIDTH - 12}
        height={height - 15}
        rx={10}
        fill="none"
        stroke={palette.rim}
      />
      <g ref={token} data-tracker-handoff="">
        <circle cx={53} cy={center + 2} r={37} fill={palette.shadow} />
        {exportId ? (
          <use href={`#${exportId}`} x={14} y={center - 40} />
        ) : (
          <image href={preview} x={14} y={center - 40} width={78} height={78} />
        )}
      </g>
      {seats.map((seat, index) => {
        const y = firstY + index * ROW;
        return (
          <g key={seat.id}>
            <rect
              x={100}
              y={y + 3}
              width={146}
              height={ROW - 6}
              rx={5}
              fill={index === 0 ? palette.paper : palette.rest}
            />
            <circle
              cx={109}
              cy={y + ROW / 2}
              r={2}
              fill={index === 0 ? palette.pin : palette.pinMuted}
            />
            <text
              x={117}
              y={y + ROW / 2 + 5}
              fill={index === 0 ? palette.ink : palette.light}
              fontFamily="system-ui,sans-serif"
              fontWeight={600}
              fontSize={14}
            >
              {seat.name.length > 13 ? seat.name.slice(0, 12) + "…" : seat.name}
            </text>
            <text
              x={238}
              y={y + ROW / 2 + 4}
              textAnchor="end"
              fill={index === 0 ? palette.count : palette.countMuted}
              fontFamily="system-ui,sans-serif"
              fontSize={11}
            >
              {seat.marks}
            </text>
          </g>
        );
      })}
    </>
  );
}

function TrackerPiece({
  editor,
  shape,
  state,
}: {
  editor: Editor;
  shape: TLGeoShape;
  state: Tracker;
}) {
  const { copy, person, locale } = useGizmoUi();
  const { seats, name, preview } = state;
  const readonly = useValue(
    "tracker access",
    () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(shape),
    [editor, shape],
  );
  const height = heightFor(seats.length);
  const firstY = (height - seats.length * ROW) / 2;
  return (
    <HTMLContainer data-gizmo-tracker="" style={{ width: shape.props.w, height: shape.props.h }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label={name[locale === "pl" ? "pl" : "en"]}
      >
        <TrackerFace seats={seats} preview={preview} />
      </svg>
      {seats.map((seat, index) => (
        <button
          aria-label={fill(copy.trackerMark, { name: seat.name })}
          data-tracker-seat=""
          key={seat.id}
          disabled={readonly}
          style={{
            top: `${(100 * (firstY + index * ROW)) / height}%`,
            height: `${(100 * ROW) / height}%`,
          }}
          onPointerDown={editor.markEventAsHandled}
          onPointerUp={editor.markEventAsHandled}
          onClick={() => markSeat(editor, shape.id, seat.id)}
          title={fill(copy.trackerMark, { name: seat.name })}
          type="button"
        />
      ))}
      {!readonly &&
        seats.length < MAX_SEATS &&
        !seats.some((seat) => seat.name === person.name) && (
          <button
            data-tracker-join=""
            title={copy.trackerJoin}
            aria-label={copy.trackerJoin}
            onPointerDown={editor.markEventAsHandled}
            onPointerUp={editor.markEventAsHandled}
            onClick={() => joinTracker(editor, shape.id, person.name)}
            type="button"
          >
            +
          </button>
        )}
    </HTMLContainer>
  );
}

const lastLocalHit = new WeakMap<Editor, number>();
const lastShake = new WeakMap<Editor, number>();
const HIT_INTERVAL = 650;

function Pressable({
  burst,
  shake,
  editor,
  shape,
  state,
}: {
  editor: Editor;
  shape: TLGeoShape;
  state: Actuator;
  burst?: string;
  shake: boolean;
}) {
  const { locale } = useGizmoUi();
  const readonly = useValue(
    "button access",
    () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(shape),
    [editor, shape],
  );
  const plate = useRef<HTMLImageElement>(null);
  const sprite = useRef<HTMLImageElement>(null);
  const previous = useRef(state.hits);
  useEffect(() => {
    const before = previous.current;
    previous.current = state.hits;
    if (state.hits <= before || !plate.current || document.hidden) return;
    const now = performance.now();
    if (now - (lastShake.get(editor) ?? -Infinity) < HIT_INTERVAL) return;
    lastShake.set(editor, now);
    const settle = springGizmo(plate.current, (t) => `scale(${1 - 0.09 * t})`);
    const stopBurst =
      sprite.current && playGizmoBurst(sprite.current, plate.current, editor.getContainer());
    const canvas = shake ? editor.getContainer().querySelector(".tl-canvas") : null;
    const settleTable =
      canvas && springGizmo(canvas, (t) => `translate(${9 * t}px,${-6 * t}px)`, -45);
    return () => {
      settle();
      settleTable?.();
      stopBurst?.();
    };
  }, [editor, shake, state.hits]);
  function press() {
    if (readonly || performance.now() - (lastLocalHit.get(editor) ?? -Infinity) < HIT_INTERVAL)
      return;
    const latest = editor.getShape<TLGeoShape>(shape.id);
    if (!latest) return;
    const current = readPiece(latest);
    if (current?.kind !== "button" || current.url !== state.url) return;
    lastLocalHit.set(editor, performance.now());
    editor.markHistoryStoppingPoint();
    editor.updateShape<TLGeoShape>({
      id: latest.id,
      type: "geo",
      meta: { ...latest.meta, gizmo: { ...current, hits: current.hits + 1 } },
    });
    playGizmoCue(shake ? "impact" : "place");
  }
  return (
    <HTMLContainer data-gizmo-actuator="" style={{ width: shape.props.w, height: shape.props.h }}>
      {burst &&
        createPortal(
          <div data-gizmo-burst="" aria-hidden="true">
            <img ref={sprite} src={burst} alt="" draggable={false} />
          </div>,
          editor.getContainer(),
        )}
      <img ref={plate} src={state.preview} alt="" draggable={false} />
      <button
        type="button"
        data-gizmo-button=""
        data-hits={state.hits}
        aria-label={state.name[locale === "pl" ? "pl" : "en"]}
        disabled={readonly}
        onPointerDown={editor.markEventAsHandled}
        onPointerUp={editor.markEventAsHandled}
        onClick={press}
      />
    </HTMLContainer>
  );
}

function StandardGeo({ util, shape }: { util: GeoShapeUtil; shape: TLGeoShape }) {
  return GeoShapeUtil.prototype.component.call(util, shape);
}

function InstalledPiece({
  util,
  shape,
  state,
}: {
  util: GizmoGeoUtil;
  shape: TLGeoShape;
  state: Actuator | Tracker;
}) {
  const installed = useInstalledGizmo(state.url);
  const manifest = installed?.manifest;
  if (
    manifest?.preview === state.preview &&
    manifest.name.en === state.name.en &&
    manifest.name.pl === state.name.pl
  ) {
    if (state.kind === "tracker" && manifest.kind === "tracker")
      return <TrackerPiece editor={util.editor} shape={shape} state={state} />;
    if (state.kind === "button" && manifest.kind === "button")
      return (
        <Pressable
          editor={util.editor}
          shape={shape}
          state={state}
          burst={manifest.burst}
          shake={manifest.effect === "shake"}
        />
      );
  }
  return <StandardGeo util={util} shape={shape} />;
}

export class GizmoGeoUtil extends GeoShapeUtil {
  override component(shape: TLGeoShape) {
    const state = readPiece(shape);
    return state ? (
      <InstalledPiece util={this} shape={shape} state={state} />
    ) : (
      <StandardGeo util={this} shape={shape} />
    );
  }
  override canEdit(shape: TLGeoShape) {
    return !readPiece(shape) && super.canEdit(shape);
  }
  override isAspectRatioLocked(shape: TLGeoShape) {
    return !!readPiece(shape) || super.isAspectRatioLocked(shape);
  }
  override getShapeName(shape: TLGeoShape) {
    return (
      readPiece(shape)?.name[this.editor.user.getLocale() === "pl" ? "pl" : "en"] ??
      super.getShapeName(shape)
    );
  }
  override toSvg(shape: TLGeoShape, ctx: SvgExportContext) {
    const state = readPiece(shape);
    if (!state) return super.toSvg(shape, ctx);
    const exportId = `gizmo-art-${shape.id.replaceAll(/[^a-z0-9_-]/gi, "_")}`;
    const { w, h } = shape.props;
    const isTracker = state.kind === "tracker";
    ctx.addExportDef({
      key: exportId,
      getElement: async () => (
        <image
          id={exportId}
          href={await FileHelpers.urlToDataUrl(state.preview)}
          width={isTracker ? 78 : w}
          height={isTracker ? 78 : h}
        />
      ),
    });
    if (state.kind === "button") return <use href={`#${exportId}`} />;
    return (
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${WIDTH} ${heightFor(state.seats.length)}`}
        preserveAspectRatio="none"
      >
        <TrackerFace seats={state.seats} preview={state.preview} exportId={exportId} />
      </svg>
    );
  }
}
