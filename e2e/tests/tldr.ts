import { expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// What the board's images and .tldr files are checked against: the
// fixtures (e2e/fixtures/make-fixtures.ts) and what a browser downloads.

export const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type FileRecord = {
  fromId?: string;
  id: string;
  index?: string;
  name?: string;
  parentId?: string;
  props?: Record<string, unknown> & { assetId?: string | null; src?: string | null };
  toId?: string;
  typeName: string;
};

export type Document = {
  assets: FileRecord[];
  bindings: FileRecord[];
  pages: FileRecord[];
  shapes: FileRecord[];
};

const byId = (a: FileRecord, b: FileRecord) => a.id.localeCompare(b.id);
const byIndex = (a: FileRecord, b: FileRecord) => (a.index! < b.index! ? -1 : 1);

// The document a .tldr holds, without what belongs to one person's
// session (camera, selection, pointer) or to the file (its document
// record). Each embedded image stands as the SHA-256 of its bytes.
export function documentOf(json: string): Document {
  const { records } = JSON.parse(json) as { records: FileRecord[] };
  const of = (typeName: string) => records.filter((record) => record.typeName === typeName);
  return {
    assets: of("asset")
      .map((asset) => {
        const { src } = asset.props!;
        if (typeof src !== "string" || !src.startsWith("data:")) return asset;
        const bytes = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
        return { ...asset, props: { ...asset.props, src: `sha256:${sha256(bytes)}` } };
      })
      .sort(byId),
    bindings: of("binding").sort(byId),
    pages: of("page").sort(byIndex),
    shapes: of("shape").sort(byId),
  };
}

export const documentOfFile = (name: string) => documentOf(readFileSync(fixture(name), "utf8"));

// Every reference inside the document leads to a record in it, on the
// same page.
export function expectWhole(document: Document): void {
  const pages = new Set(document.pages.map((page) => page.id));
  const shapes = new Map(document.shapes.map((shape) => [shape.id, shape]));
  const assets = new Set(document.assets.map((asset) => asset.id));
  const pageOf = (id: string): string => {
    const shape = shapes.get(id);
    if (shape === undefined) return id;
    return pageOf(shape.parentId!);
  };
  for (const shape of document.shapes) {
    expect(pages.has(pageOf(shape.id)), `${shape.id} is on a page`).toBe(true);
    if (typeof shape.props?.assetId === "string")
      expect(assets.has(shape.props.assetId)).toBe(true);
  }
  for (const binding of document.bindings) {
    expect(shapes.has(binding.fromId!), `${binding.id} starts on a shape`).toBe(true);
    expect(shapes.has(binding.toId!), `${binding.id} ends on a shape`).toBe(true);
    expect(pageOf(binding.fromId!)).toBe(pageOf(binding.toId!));
  }
}

const menu = async (page: Page, item: string) => {
  await page.getByTestId("main-menu.button").click();
  await page.getByRole("menuitem", { name: item }).click();
};

export async function openTldr(page: Page, name: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await menu(page, "Import a .tldr file…");
  const picker = await chooser;
  await picker.setFiles(fixture(name));
}

export async function downloadTldr(page: Page): Promise<string> {
  const download = page.waitForEvent("download");
  await menu(page, "Download board (.tldr)");
  const downloaded = await download;
  const file = await downloaded.path();
  return readFileSync(file, "utf8");
}

export async function uploadImage(page: Page, name: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await menu(page, "Upload media…");
  const picker = await chooser;
  await picker.setFiles(fixture(name));
}

// Drops a file onto the board as a person dragging it from their desktop.
export async function dropFile(page: Page, name: string, type: string): Promise<void> {
  const content = readFileSync(fixture(name)).toString("base64");
  const transfer = await page.evaluateHandle(
    ({ content, name, type }) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob(content), (char) => char.codePointAt(0)!);
      data.items.add(new File([bytes], name, { type }));
      return data;
    },
    { content, name, type },
  );
  await page.getByTestId("canvas").dispatchEvent("drop", { dataTransfer: transfer });
}

// The board's images that have actually loaded, as the addresses they came
// from: an <img> that failed or is still waiting does not count.
export const loadedImages = (page: Page): Promise<string[]> =>
  page
    .getByTestId("canvas")
    .locator("img.tl-image")
    .evaluateAll((images) =>
      (images as HTMLImageElement[])
        .filter((image) => image.complete && image.naturalWidth > 0)
        .map((image) => new URL(image.src).pathname),
    );

export const toast = (page: Page, text: string): Locator => page.getByText(text, { exact: true });

export async function zoomToFit(page: Page): Promise<void> {
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await page.getByTestId("canvas").focus();
  await page.keyboard.press("Shift+1");
}
