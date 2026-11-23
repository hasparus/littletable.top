import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { createRoot } from "react-dom/client";
import {
  allDefaultFontFaces,
  createShapeId,
  type Editor,
  PageRecordType,
  renderHtmlFromRichTextForMeasurement,
  Tldraw,
  type TLRichText,
  toRichText,
} from "tldraw";
import "tldraw/tldraw.css";

import { applyOps } from "../../src/mcp/upstream/canvas-ops/ops";
import { type Step } from "./corpus";

// What the harness answers for one label in one font and size: the raw
// measurements tldraw takes, and what its shape utils make of them.
export type BrowserCase = {
  family: string;
  richText: TLRichText;
  size: string;
};

const LABEL_PX = { l: 26, m: 22, s: 18, xl: 32 } as const;
const TEXT_PX = { l: 36, m: 24, s: 18, xl: 44 } as const;

type Px = keyof typeof LABEL_PX;

function measure(
  editor: Editor,
  richText: TLRichText,
  family: string,
  px: number,
  maxWidth: number | null,
) {
  const html = renderHtmlFromRichTextForMeasurement(editor, richText);
  const { h, w } = editor.textMeasure.measureHtml(html, {
    fontFamily: `var(--tl-font-${family})`,
    fontSize: px,
    fontStyle: "normal",
    fontVariant: "normal",
    fontWeight: "normal",
    lineHeight: 1.35,
    maxWidth,
    padding: "0px",
  } as never);
  return { h, w };
}

function collect(editor: Editor, cases: BrowserCase[]) {
  return cases.map(({ family, richText, size }) => {
    const label = LABEL_PX[size as Px];
    const text = TEXT_PX[size as Px];
    const geo = createShapeId();
    const note = createShapeId();
    const autoText = createShapeId();
    const fixedText = createShapeId();
    const props = { font: family, richText, size } as never;
    editor.createShapes([
      { id: geo, props: { ...(props as object), h: 100, w: 200 }, type: "geo", x: 0, y: 0 },
      { id: note, props, type: "note", x: 0, y: 400 },
      { id: autoText, props: { ...(props as object), autoSize: true }, type: "text", x: 400, y: 0 },
      {
        id: fixedText,
        props: { ...(props as object), autoSize: false, w: 220 },
        type: "text",
        x: 800,
        y: 0,
      },
    ] as never);
    const bounds = (id: typeof geo) => {
      const box = editor.getShapePageBounds(id)!;
      return { h: box.h, w: box.w };
    };
    const result = {
      family,
      geo: { growY: (editor.getShape(geo)!.props as { growY: number }).growY, ...bounds(geo) },
      label: {
        unwrapped: measure(editor, richText, family, label, null),
        wrapped168: measure(editor, richText, family, label, 168),
      },
      note: {
        fontSizeAdjustment: (editor.getShape(note)!.props as { fontSizeAdjustment: number })
          .fontSizeAdjustment,
        growY: (editor.getShape(note)!.props as { growY: number }).growY,
      },
      richText,
      size,
      text: {
        auto: bounds(autoText),
        fixed220: bounds(fixedText),
        unwrapped: measure(editor, richText, family, text, null),
      },
    };
    editor.deleteShapes([geo, note, autoText, fixedText]);
    return result;
  });
}

// One fidelity scenario: a page set up through the real editor, then a batch
// of ops run by tldraw's own engine on it. The records before and after go
// back to the test, which runs the same batch on the stand-in editor.
const DOCUMENT = new Set(["binding", "document", "page", "shape"]);

function documentOf(editor: Editor) {
  return structuredClone(
    editor.store.allRecords().filter((record) => DOCUMENT.has(record.typeName)),
  );
}

function scenario(editor: Editor, name: string, steps: Step[], ops: object[]) {
  const pageId = PageRecordType.createId(name);
  editor.createPage({ id: pageId, name });
  editor.setCurrentPage(pageId);
  for (const step of steps) {
    if (step.do === "create") editor.createShapes(step.shapes as never);
    else if (step.do === "rotate")
      editor.rotateShapesBy(
        step.ids.map((id) => createShapeId(id)),
        step.by,
      );
    else
      editor.groupShapes(
        step.ids.map((id) => createShapeId(id)),
        { groupId: createShapeId(step.id) },
      );
  }
  editor.selectNone();
  const before = documentOf(editor);
  const result = applyOps(editor as never, ops as never, {});
  editor.selectNone();
  editor.zoomToFit({ animation: { duration: 0 } });
  return { after: documentOf(editor), before, pageId, result };
}

// Shows records another engine produced, on a page of their own.
function show(editor: Editor, records: object[], pageId: string) {
  editor.store.mergeRemoteChanges(() => editor.store.put(records as never));
  editor.setCurrentPage(pageId as never);
  editor.selectNone();
  editor.zoomToFit({ animation: { duration: 0 } });
}

declare global {
  var harness: {
    collect: (cases: BrowserCase[]) => ReturnType<typeof collect>;
    editor: Editor;
    scenario: (name: string, steps: Step[], ops: object[]) => ReturnType<typeof scenario>;
    show: (records: object[], pageId: string) => void;
    toRichText: typeof toRichText;
  };
}

createRoot(document.getElementById("root")!).render(
  <Tldraw
    assetUrls={getAssetUrlsByImport()}
    onMount={(editor) => {
      void Promise.all(allDefaultFontFaces.map((face) => editor.fonts.ensureFontIsLoaded(face)))
        .then(() => document.fonts.ready)
        .then(() => {
          globalThis.harness = {
            collect: (cases) => collect(editor, cases),
            editor,
            scenario: (name, steps, ops) => scenario(editor, name, steps, ops),
            show: (records, pageId) => show(editor, records, pageId),
            toRichText,
          };
        });
    }}
  />,
);
