// WARNING: Regenerate these fixtures with `node e2e/fixtures/make-fixtures.ts` when changing the installed tldraw schema.

import {
  b64Vecs,
  createTLSchema,
  type TLRecord,
  type TLRichText,
  toRichText,
} from "@tldraw/tlschema";
import { writeFileSync } from "node:fs";

import { png } from "./png.ts";

const here = (name: string) => new URL(name, import.meta.url);

const map = png(96, 64, [33, 102, 172]);
const portrait = png(48, 72, [178, 24, 43]);
writeFileSync(here("map.png"), map);
writeFileSync(here("portrait.png"), portrait);

const schema = createTLSchema();

const base = { isLocked: false, meta: {}, opacity: 1, rotation: 0, typeName: "shape" as const };
const style = { color: "black", dash: "draw", fill: "none", font: "draw", size: "m" };
const geo = (props: Record<string, unknown>) => ({
  align: "middle",
  ...style,
  flipX: false,
  flipY: false,
  geo: "rectangle",
  growY: 0,
  h: 120,
  labelColor: "black",
  richText: toRichText(""),
  scale: 1,
  url: "",
  verticalAlign: "middle",
  w: 160,
  ...props,
});

const boldAndPlain: TLRichText = {
  content: [
    {
      content: [
        { marks: [{ type: "bold" }], text: "Initiative", type: "text" },
        { text: " goes clockwise", type: "text" },
      ],
      type: "paragraph",
    },
    { content: [{ text: "Second line", type: "text" }], type: "paragraph" },
  ],
  type: "doc",
};

const records = [
  { gridSize: 10, id: "document:document", meta: {}, name: "", typeName: "document" },
  { id: "page:map", index: "a1", meta: {}, name: "The map", typeName: "page" },
  { id: "page:table", index: "a2", meta: {}, name: "The table", typeName: "page" },
  { id: "page:notes", index: "a3", meta: { kept: "page meta" }, name: "Notes", typeName: "page" },

  {
    ...base,
    id: "shape:hall",
    index: "a1",
    meta: { place: "The hall" },
    parentId: "page:table",
    props: { color: "violet", h: 360, name: "The hall", w: 520 },
    type: "frame",
    x: 0,
    y: 0,
  },
  {
    ...base,
    id: "shape:hall-door",
    index: "a1",
    parentId: "shape:hall",
    props: geo({ color: "red", fill: "semi", richText: toRichText("Door") }),
    type: "geo",
    x: 40,
    y: 60,
  },
  {
    ...base,
    id: "shape:hall-note",
    index: "a2",
    parentId: "shape:hall",
    props: {
      align: "start",
      color: "yellow",
      font: "sans",
      fontSizeAdjustment: 0,
      growY: 0,
      labelColor: "black",
      richText: toRichText("Trap under the rug"),
      scale: 1,
      size: "s",
      textLastEditedBy: null,
      url: "",
      verticalAlign: "start",
    },
    type: "note",
    x: 260,
    y: 80,
  },

  {
    ...base,
    id: "shape:party",
    index: "a2",
    parentId: "page:table",
    props: {},
    type: "group",
    x: 600,
    y: 0,
  },
  {
    ...base,
    id: "shape:party-a",
    index: "a1",
    parentId: "shape:party",
    props: geo({ color: "green", fill: "solid", geo: "ellipse", h: 60, w: 60 }),
    type: "geo",
    x: 0,
    y: 0,
  },
  {
    ...base,
    id: "shape:party-b",
    index: "a2",
    parentId: "shape:party",
    props: geo({ color: "blue", dash: "dashed", geo: "ellipse", h: 60, w: 60 }),
    type: "geo",
    x: 80,
    y: 20,
  },

  {
    ...base,
    id: "shape:camp",
    index: "a3",
    parentId: "page:table",
    props: geo({ font: "serif", richText: toRichText("Camp") }),
    type: "geo",
    x: 0,
    y: 480,
  },
  {
    ...base,
    id: "shape:tower",
    index: "a4",
    parentId: "page:table",
    props: geo({ dash: "dotted", fill: "pattern", geo: "hexagon", richText: toRichText("Tower") }),
    type: "geo",
    x: 420,
    y: 520,
  },
  {
    ...base,
    id: "shape:road",
    index: "a5",
    parentId: "page:table",
    props: {
      ...style,
      arrowheadEnd: "arrow",
      arrowheadStart: "dot",
      bend: 30,
      color: "orange",
      elbowMidPoint: 0.5,
      end: { x: 420, y: 80 },
      kind: "arc",
      labelColor: "black",
      labelPosition: 0.5,
      richText: toRichText("Two days"),
      scale: 1,
      size: "l",
      start: { x: 0, y: 0 },
    },
    type: "arrow",
    x: 160,
    y: 540,
  },
  {
    fromId: "shape:road",
    id: "binding:road-start",
    meta: {},
    props: {
      isExact: false,
      isPrecise: true,
      normalizedAnchor: { x: 0.9, y: 0.4 },
      snap: "none",
      terminal: "start",
    },
    toId: "shape:camp",
    type: "arrow",
    typeName: "binding",
  },
  {
    fromId: "shape:road",
    id: "binding:road-end",
    meta: {},
    props: {
      isExact: false,
      isPrecise: false,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      snap: "none",
      terminal: "end",
    },
    toId: "shape:tower",
    type: "arrow",
    typeName: "binding",
  },

  {
    ...base,
    id: "shape:rules",
    index: "a6",
    parentId: "page:table",
    props: {
      autoSize: true,
      color: "light-blue",
      font: "mono",
      richText: boldAndPlain,
      scale: 1.5,
      size: "xl",
      textAlign: "start",
      w: 300,
    },
    rotation: 0.1,
    type: "text",
    x: 700,
    y: 300,
  },
  {
    ...base,
    id: "shape:scribble",
    index: "a7",
    opacity: 0.5,
    parentId: "page:table",
    props: {
      color: "light-red",
      dash: "draw",
      fill: "none",
      isClosed: false,
      isComplete: true,
      isPen: false,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      segments: [
        {
          path: b64Vecs.encodePoints([
            { x: 0, y: 0, z: 0.5 },
            { x: 12, y: 8, z: 0.5 },
            { x: 30, y: 4, z: 0.5 },
            { x: 48, y: 20, z: 0.5 },
          ]),
          type: "free",
        },
      ],
      size: "m",
    },
    type: "draw",
    x: 700,
    y: 500,
  },

  {
    id: "asset:map",
    meta: {},
    props: {
      fileSize: map.length,
      h: 64,
      isAnimated: false,
      mimeType: "image/png",
      name: "map.png",
      src: `data:image/png;base64,${map.toString("base64")}`,
      w: 96,
    },
    type: "image",
    typeName: "asset",
  },
  {
    ...base,
    id: "shape:map",
    index: "a1",
    isLocked: true,
    meta: { place: "The map" },
    parentId: "page:map",
    props: {
      altText: "A map of the valley",
      assetId: "asset:map",
      crop: { bottomRight: { x: 0.9, y: 0.75 }, topLeft: { x: 0.1, y: 0.25 } },
      flipX: false,
      flipY: false,
      h: 192,
      playing: true,
      url: "",
      w: 461,
    },
    type: "image",
    x: 0,
    y: 0,
  },

  {
    id: "asset:portrait",
    meta: {},
    props: {
      fileSize: portrait.length,
      h: 72,
      isAnimated: false,
      mimeType: "image/png",
      name: "portrait.png",
      src: `data:image/png;base64,${portrait.toString("base64")}`,
      w: 48,
    },
    type: "image",
    typeName: "asset",
  },
  {
    ...base,
    id: "shape:portrait",
    index: "a1",
    parentId: "page:notes",
    props: {
      altText: "",
      assetId: "asset:portrait",
      crop: null,
      flipX: true,
      flipY: false,
      h: 216,
      playing: true,
      url: "",
      w: 144,
    },
    type: "image",
    x: 0,
    y: 0,
  },
  {
    ...base,
    id: "shape:portrait-note",
    index: "a2",
    parentId: "page:notes",
    props: {
      align: "middle",
      color: "light-green",
      font: "draw",
      fontSizeAdjustment: 0,
      growY: 0,
      labelColor: "black",
      richText: toRichText("Bea's character"),
      scale: 1,
      size: "m",
      textLastEditedBy: null,
      url: "",
      verticalAlign: "middle",
    },
    type: "note",
    x: 200,
    y: 0,
  },
] as unknown as TLRecord[];

for (const record of records) schema.types[record.typeName].validate(record);

const serialized = schema.serialize();
const file = (body: object) => `${JSON.stringify(body, null, 2)}\n`;
writeFileSync(
  here("table.tldr"),
  file({ records, schema: serialized, tldrawFileFormatVersion: 1 }),
);

const older = structuredClone(serialized);
for (const [sequence, version] of Object.entries(older.sequences)) {
  if (version === 0) continue;
  const trial = { ...older, sequences: { ...older.sequences, [sequence]: version - 1 } };
  const stepped = records.map((record) => schema.migratePersistedRecord(record, trial, "down"));
  if (stepped.every((result) => result.type === "success")) older.sequences[sequence] = version - 1;
}
const olderRecords = records.map((record) => {
  const result = schema.migratePersistedRecord(record, older, "down");
  if (result.type !== "success") throw new Error(`cannot step ${record.id} back`);
  return result.value;
});
writeFileSync(
  here("table-older.tldr"),
  file({ records: olderRecords, schema: older, tldrawFileFormatVersion: 1 }),
);

const newer = structuredClone(serialized);
newer.sequences["com.tldraw.shape.geo"] = (newer.sequences["com.tldraw.shape.geo"] ?? 0) + 1;
writeFileSync(
  here("table-newer.tldr"),
  file({ records, schema: newer, tldrawFileFormatVersion: 1 }),
);

const changed = Object.entries(older.sequences).filter(
  ([sequence, version]) => version !== serialized.sequences[sequence],
);
process.stdout.write(
  `fixtures written; the older file steps back ${changed.map(([name]) => name).join(", ")}\n`,
);
