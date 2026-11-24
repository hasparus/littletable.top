/// <reference lib="webworker" />
// The text worker: reads one image at a time with the engines it is asked
// for, off the main thread (docs/internals.md, "Text in images"). The image is
// decoded once, drawn once at the engines' cap, and let go after; each
// engine loads the first time it is needed and stays for the next image
// until the board lets the worker go.
//
// NOTE: tesseract.js runs Tesseract in a worker of its own, which it
// starts from this one (from its file on this origin, never a blob: URL).

import * as ort from "onnxruntime-web/wasm";
import { createWorker, type Worker as Tesseract } from "tesseract.js";
import files from "virtual:text-engine-files";

import type { Box, EngineName, Quad, TextLine, TextWord } from "../../src/text-result";

import dictionary from "../ocr/ppocr-v6-tiny-dict.json";
import { createPipeline, type PaddleWord, type Pipeline, type Pixels } from "./ppocr";
import { hasSimd, MAX_SIDE } from "./text-support";

export type ReadRequest = { bytes: ArrayBuffer; engines: EngineName[]; id: number; type: "read" };

export type ReadReply =
  | { engine: EngineName; id: number; lines: TextLine[]; ms: number; size: Size; type: "read" }
  | { engine: EngineName; id: number; message: string; type: "failed" }
  | { id: number; type: "done" };

export type Size = { height: number; width: number };

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

let tesseract: Promise<Tesseract> | null = null;
let paddle: Promise<Pipeline> | null = null;

const absolute = (path: string) => new URL(path, scope.location.origin).href;

function startTesseract(): Promise<Tesseract> {
  tesseract ??= (async () => {
    const reader = await createWorker(["pol", "eng"], 1, {
      cacheMethod: "none",
      corePath: absolute(hasSimd() ? files.tesseractCore : files.tesseractCoreNoSimd),
      gzip: true,
      langPath: absolute(files.tessdata),
      workerBlobURL: false,
      workerPath: absolute(files.tesseractWorker),
    });
    // Sparse text: words anywhere, in any order, as on a map or a sheet.
    await reader.setParameters({ tessedit_pageseg_mode: "11" as never });
    return reader;
  })();
  return tesseract;
}

async function bytesOf(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`text worker: ${path} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function startPaddle(): Promise<Pipeline> {
  paddle ??= (async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const [detector, recogniser] = await Promise.all([
      bytesOf(files.detector),
      bytesOf(files.recogniser),
    ]);
    return createPipeline({
      dict: dictionary,
      models: { detector, recogniser },
      runtime: {
        makeTensor: (data, dims) => new ort.Tensor("float32", data, dims),
        session: async (model) => {
          const session = await ort.InferenceSession.create(model, {
            executionProviders: ["wasm"],
          });
          return {
            inputNames: session.inputNames,
            outputNames: session.outputNames,
            release: () => session.release(),
            run: (feeds) => session.run(feeds as Record<string, ort.Tensor>),
          };
        },
      },
    });
  })();
  return paddle;
}

const round = (value: number) => Math.round(value);

// A box in the source image's pixels, clamped inside it; null once it has
// no area left.
function boxIn(size: Size, [x0, y0, x1, y1]: Box): Box | null {
  const box: Box = [
    Math.max(0, round(x0)),
    Math.max(0, round(y0)),
    Math.min(size.width, round(x1)),
    Math.min(size.height, round(y1)),
  ];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}

function quadIn(size: Size, points: readonly (readonly [number, number])[]): Quad {
  return points.flatMap(([x, y]) => [
    Math.min(size.width, Math.max(0, round(x))),
    Math.min(size.height, Math.max(0, round(y))),
  ]) as Quad;
}

const boundsOf = (points: readonly (readonly [number, number])[]): Box => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

type TesseractBox = { x0: number; x1: number; y0: number; y1: number };
type TesseractLine = {
  bbox: TesseractBox;
  words: { bbox: TesseractBox; confidence: number; text: string }[];
};

async function readTesseract(
  picture: OffscreenCanvas,
  scale: number,
  size: Size,
): Promise<TextLine[]> {
  const reader = await startTesseract();
  const png = await picture.convertToBlob({ type: "image/png" });
  const { data } = await reader.recognize(png, {}, { blocks: true, text: false });
  const up = ({ x0, x1, y0, y1 }: TesseractBox): Box => [
    x0 / scale,
    y0 / scale,
    x1 / scale,
    y1 / scale,
  ];
  const lines: TextLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines as TesseractLine[]) {
        const words = line.words.flatMap((word): TextWord[] => {
          const b = boxIn(size, up(word.bbox));
          const t = word.text.trim();
          return b === null || t.length === 0
            ? []
            : [{ b, c: Math.round(word.confidence) / 100, t }];
        });
        const box = boxIn(size, up(line.bbox));
        if (words.length > 0 && box !== null) lines.push({ box, words });
      }
    }
  }
  return lines;
}

function paddleLines(words: PaddleWord[], scale: number, size: Size): TextLine[] {
  const lines = new Map<number, PaddleWord[]>();
  for (const word of words) lines.set(word.line, [...(lines.get(word.line) ?? []), word]);
  return [...lines.values()].flatMap((line): TextLine[] => {
    const up = (word: PaddleWord) => word.quad.map(([x, y]) => [x / scale, y / scale] as const);
    const kept = line.flatMap((word): TextWord[] => {
      const corners = up(word);
      const b = boxIn(size, boundsOf(corners));
      if (b === null) return [];
      return [{ b, c: Math.round(word.conf * 100) / 100, q: quadIn(size, corners), t: word.text }];
    });
    const first = up(line[0]!);
    const last = up(line.at(-1)!);
    const corners = [first[0]!, last[1]!, last[2]!, first[3]!];
    const box = boxIn(size, boundsOf(line.flatMap(up)));
    return kept.length === 0 || box === null
      ? []
      : [{ box, quad: quadIn(size, corners), words: kept }];
  });
}

async function readPaddle(
  picture: OffscreenCanvas,
  scale: number,
  size: Size,
): Promise<TextLine[]> {
  const pipeline = await startPaddle();
  const context = picture.getContext("2d", { willReadFrequently: true })!;
  const pixels: Pixels = context.getImageData(0, 0, picture.width, picture.height);
  const { words } = await pipeline.recognize(pixels);
  return paddleLines(words, scale, size);
}

// The image as the board shows it: a photo's EXIF orientation applied, so
// the words' boxes are where they show. The Worker checks the size the
// same way (src/image-size.ts).
async function upright(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch (error) {
    // NOTE: a browser from before "from-image" refuses the value. Its
    // default may leave a JPEG sideways; the Worker then refuses the
    // reading's size, and the image stays unread rather than misplaced.
    if (!(error instanceof TypeError)) throw error;
    return createImageBitmap(blob);
  }
}

async function read({ bytes, engines, id }: ReadRequest): Promise<void> {
  const bitmap = await upright(new Blob([bytes]));
  const size = { height: bitmap.height, width: bitmap.width };
  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  const picture = new OffscreenCanvas(
    Math.max(1, Math.round(size.width * scale)),
    Math.max(1, Math.round(size.height * scale)),
  );
  const context = picture.getContext("2d", { willReadFrequently: true })!;
  // NOTE: text on a transparent image reads against white, as it shows on
  // the board's light canvas.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, picture.width, picture.height);
  context.drawImage(bitmap, 0, 0, picture.width, picture.height);
  bitmap.close();
  try {
    for (const engine of engines) {
      const started = performance.now();
      try {
        const lines =
          engine === "tesseract"
            ? await readTesseract(picture, scale, size)
            : await readPaddle(picture, scale, size);
        scope.postMessage({
          engine,
          id,
          lines,
          ms: performance.now() - started,
          size,
          type: "read",
        } satisfies ReadReply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        scope.postMessage({ engine, id, message, type: "failed" } satisfies ReadReply);
      }
    }
  } finally {
    picture.width = 0;
    picture.height = 0;
  }
}

scope.addEventListener("message", (event: MessageEvent<ReadRequest>) => {
  const request = event.data;
  read(request)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const engine of request.engines) {
        scope.postMessage({ engine, id: request.id, message, type: "failed" } satisfies ReadReply);
      }
    })
    .finally(() => scope.postMessage({ id: request.id, type: "done" } satisfies ReadReply));
});
