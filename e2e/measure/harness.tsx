import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { createRoot } from "react-dom/client";
import {
  allDefaultFontFaces,
  createShapeId,
  type Editor,
  renderHtmlFromRichTextForMeasurement,
  type TLRichText,
  Tldraw,
  toRichText,
} from "tldraw";
import "tldraw/tldraw.css";

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

declare global {
  var harness: {
    collect: (cases: BrowserCase[]) => ReturnType<typeof collect>;
    editor: Editor;
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
            toRichText,
          };
        });
    }}
  />,
);
