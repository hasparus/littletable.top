/// <reference lib="webworker" />

import { createTLSchema } from "@tldraw/tlschema";
import {
  MigrationFailureReason,
  parseTldrawJsonFile,
  type TLAsset,
  type TLBinding,
  type TLPage,
  type TLShape,
} from "tldraw";

import type { ImportProblem } from "./tldr";

import { fileFromDataUrl } from "./data-url-file";

export type BoardDocument = {
  assets: TLAsset[];
  bindings: TLBinding[];
  embedded: Map<TLAsset["id"], File>;
  pages: TLPage[];
  shapes: TLShape[];
};

export type ImportReply =
  | { document: BoardDocument; kind: "loaded" }
  | { image?: string; kind: "failed"; problem: ImportProblem }
  | { kind: "preparing" }
  | { kind: "reading"; percent: number };

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const reply = (message: ImportReply) => scope.postMessage(message);

// The board uses tldraw's default record schema, including on the public
// board where we override arrow behaviour and leave its schema in place.
const schema = createTLSchema();

function parse(json: string): void {
  const parsed = parseTldrawJsonFile({ json, schema });
  if (!parsed.ok) {
    const { error } = parsed;
    let problem: ImportProblem;
    switch (error.type) {
      case "fileFormatVersionTooNew":
        problem = "too-new";
        break;
      case "invalidRecords":
        problem = "damaged";
        break;
      case "migrationFailed": {
        // The parser can report a generic migration error for a newer shape.
        const ours = schema.serialize().sequences;
        const theirs = (JSON.parse(json) as { schema: { sequences?: Record<string, number> } })
          .schema.sequences;
        const newer = Object.entries(theirs ?? {}).some(
          ([sequence, version]) => sequence in ours && version > ours[sequence]!,
        );
        problem =
          error.reason === MigrationFailureReason.TargetVersionTooNew || newer
            ? "too-new"
            : "damaged";
        break;
      }
      case "notATldrawFile":
        problem = "not-tldraw";
        break;
      case "v1File":
        problem = "legacy";
        break;
    }
    reply({ kind: "failed", problem });
    return;
  }

  const document: BoardDocument = {
    assets: [],
    bindings: [],
    embedded: new Map(),
    pages: [],
    shapes: [],
  };
  for (const record of parsed.value.allRecords()) {
    if (record.typeName === "page") document.pages.push(record);
    if (record.typeName === "shape") document.shapes.push(record);
    if (record.typeName === "binding") document.bindings.push(record);
    if (record.typeName !== "asset") continue;
    if (record.type !== "bookmark" && record.props.src?.startsWith("data:")) {
      try {
        document.embedded.set(record.id, fileFromDataUrl(record.props.src, record.props.name));
      } catch {
        reply({ image: record.props.name, kind: "failed", problem: "damaged-image" });
        return;
      }
      document.assets.push({ ...record, props: { ...record.props, src: null } });
    } else {
      document.assets.push(record);
    }
  }
  // Blobs can be shared with the main thread without copying the base64
  // strings from the file or decoding its images on the canvas thread.
  reply({ document, kind: "loaded" });
}

scope.addEventListener("message", ({ data }: MessageEvent<File>) => {
  const reader = new FileReader();
  reader.addEventListener("progress", ({ loaded, total }) => {
    if (total > 0) reply({ kind: "reading", percent: Math.round((loaded / total) * 100) });
  });
  reader.addEventListener("error", () => reply({ kind: "failed", problem: "unreadable" }));
  reader.addEventListener("load", () => {
    reply({ kind: "preparing" });
    try {
      parse(reader.result as string);
    } catch {
      reply({ kind: "failed", problem: "damaged" });
    }
  });
  // oxlint-disable-next-line unicorn/prefer-blob-reading-methods -- FileReader reports bytes read.
  reader.readAsText(data);
});
