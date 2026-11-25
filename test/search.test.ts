import type { TLPageId, TLShapeId } from "tldraw";

import { describe, expect, it } from "vitest";

import { BoardIndex, type SearchDoc } from "../client/src/search-index";
import { closeness, excerpt, EXCERPT_LENGTH, fold, richTextWords } from "../client/src/search-text";

const PAGE_1 = "page:one" as TLPageId;
const PAGE_2 = "page:two" as TLPageId;

const native = (shape: string, text: string, page = PAGE_1): SearchDoc => ({
  id: `${shape}#text`,
  kind: "native",
  page,
  shape: `shape:${shape}` as TLShapeId,
  text,
});

const place = (shape: string, text: string, page = PAGE_1): SearchDoc => ({
  ...native(shape, text, page),
  id: `${shape}#place`,
  kind: "place",
});

function indexOf(...docs: SearchDoc[]): BoardIndex {
  const index = new BoardIndex();
  for (const shape of new Set(docs.map((doc) => doc.shape))) {
    const own = docs.filter((doc) => doc.shape === shape);
    index.setShape(shape, own[0]!.page, own);
  }
  return index;
}

const found = (index: BoardIndex, query: string) =>
  index.search(query).map((hit) => `${hit.doc.shape.slice(6)}:${hit.doc.kind}`);

const marked = (parts: ReturnType<typeof excerpt>) =>
  parts.map((part) => (part.mark ? `[${part.text}]` : part.text)).join("");

describe("folding", () => {
  it("drops Polish diacritics, ł included, and case", () => {
    expect(fold("Żółw Łąka ĆMA źdźbło")).toBe("zolw laka cma zdzblo");
  });

  it("keeps every position, so a match found folded marks the right letters", () => {
    for (const text of ["Żółw", "İstanbul", "Straße", "🐢 Łódź"]) {
      expect(fold(text)).toHaveLength(text.length);
    }
  });

  it("finds Polish text without its diacritics, and the other way round", () => {
    const index = indexOf(native("turtle", "Żółw na moście"), native("bridge", "most zwodzony"));
    expect(found(index, "zolw")).toEqual(["turtle:native"]);
    expect(found(index, "ZÓŁW")).toEqual(["turtle:native"]);
    expect(found(indexOf(native("bare", "zolw")), "Żółw")).toEqual(["bare:native"]);
  });
});

describe("ranking", () => {
  it("puts the exact spelling above a folded one, whatever the order on the board", () => {
    const index = indexOf(
      native("folded", "Spotkanie w Lodz"),
      native("exact", "Spotkanie w Łódź"),
    );
    expect(found(index, "Łódź")).toEqual(["exact:native", "folded:native"]);
    expect(found(index, "lodz")).toEqual(["folded:native", "exact:native"]);
  });

  it("forgives a typo in a longer word, not in a short one", () => {
    const index = indexOf(native("inn", "The Prancing Pony tavern"), native("cat", "cat"));
    expect(found(index, "tavren")).toEqual(["inn:native"]);
    expect(found(index, "Pomy")).toEqual(["inn:native"]);
    expect(found(index, "Prancnig")).toEqual(["inn:native"]);
    expect(found(index, "cot")).toEqual([]);
  });

  it("matches the word being typed by its start", () => {
    const index = indexOf(native("dragon", "Smok Wawelski"), native("other", "Wawrzyniec"));
    expect(found(index, "smok waw")).toEqual(["dragon:native"]);
    expect(found(index, "Wawe")).toEqual(["dragon:native"]);
  });

  it("finds by the start of a word only for one letter, without typos", () => {
    const index = indexOf(native("a", "Ania"), native("b", "Bania"), native("k", "kot"));
    expect(found(index, "a")).toEqual(["a:native"]);
    expect(found(index, "  ")).toEqual([]);
    expect(found(index, "?")).toEqual([]);
  });

  it("ranks a place above text that matches as well", () => {
    const index = indexOf(native("menu", "Tavern menu"), place("inn", "Tavern"));
    expect(found(index, "tavern")).toEqual(["inn:place", "menu:native"]);
  });

  it("shows a shape once when its text and its place name both match", () => {
    const index = indexOf(native("frame", "Dungeon level 1"), place("frame", "Dungeon"));
    expect(found(index, "dungeon")).toEqual(["frame:place"]);
  });

  it("indexes text a shape says twice once", () => {
    const index = new BoardIndex();
    index.setShape("shape:frame" as TLShapeId, PAGE_1, [
      place("frame", "Map"),
      native("frame", " map "),
    ]);
    expect(index.size).toBe(1);
  });

  it("falls back to any of several words when no text has them all", () => {
    const index = indexOf(native("sword", "Miecz dwuręczny"), native("bow", "Łuk"));
    expect(found(index, "miecz tarcza")).toEqual(["sword:native"]);
  });

  it("orders by how closely the text holds the query", () => {
    expect(closeness("Żółw", "Wielki Żółw")).toBe(3);
    expect(closeness("zolw", "Wielki Żółw")).toBe(2);
    expect(closeness("zolwie", "Wielki Żółw")).toBe(1);
    expect(closeness("ółw", "Żółw")).toBe(1);
  });
});

describe("keeping up", () => {
  it("finds a shape's new text and not its old", () => {
    const index = indexOf(native("note", "goblin camp"));
    index.setShape("shape:note" as TLShapeId, PAGE_1, [native("note", "orc camp")]);
    expect(found(index, "goblin")).toEqual([]);
    expect(found(index, "orc")).toEqual(["note:native"]);
  });

  it("forgets a deleted shape, its place name too", () => {
    const index = indexOf(native("note", "secret door"), place("note", "Secret"));
    index.removeShape("shape:note" as TLShapeId);
    expect(found(index, "secret")).toEqual([]);
    expect(index.size).toBe(0);
  });

  it("follows a shape moved to another page", () => {
    const index = indexOf(native("note", "treasure"));
    index.setShape("shape:note" as TLShapeId, PAGE_2, [native("note", "treasure", PAGE_2)]);
    expect(index.search("treasure").map((hit) => hit.doc.page)).toEqual([PAGE_2]);
  });

  it("forgets a deleted page's shapes and keeps the rest", () => {
    const index = indexOf(native("here", "key", PAGE_1), native("gone", "key ring", PAGE_2));
    index.removePage(PAGE_2);
    expect(found(index, "key")).toEqual(["here:native"]);
  });
});

describe("lines read off an image", () => {
  const MAP = "shape:map" as TLShapeId;
  const line = (n: number, text: string): SearchDoc => ({
    ...native("map", text),
    id: `map#ocr:${n}`,
    kind: "ocr",
    region: [
      { x: 0, y: n * 10 },
      { x: 50, y: n * 10 },
      { x: 50, y: n * 10 + 8 },
      { x: 0, y: n * 10 + 8 },
    ],
  });

  function mapIndex(): BoardIndex {
    const index = new BoardIndex();
    index.setShape(MAP, PAGE_1, [native("map", "Region map")]);
    return index;
  }

  it("keeps each line a result of its own, beside the image's own text", () => {
    const index = mapIndex();
    index.setImageText(MAP, [line(0, "Ravenhold"), line(1, "Ravenhold keep"), line(2, "Region")]);
    expect(found(index, "ravenhold")).toEqual(["map:ocr", "map:ocr"]);
    expect(new Set(found(index, "region"))).toEqual(new Set(["map:native", "map:ocr"]));
  });

  it("replaces an older reading with a newer one, and keeps the shape's own text", () => {
    const index = mapIndex();
    index.setImageText(MAP, [line(0, "Raverhold")]);
    index.setImageText(MAP, [line(0, "Ravenhold"), line(1, "Greywater")]);
    expect(index.search("raverhold").map((hit) => hit.doc.text)).toEqual(["Ravenhold"]);
    expect(found(index, "greywater")).toEqual(["map:ocr"]);
    expect(found(index, "region")).toEqual(["map:native"]);
  });

  it("keeps the lines when the image's own text changes, and moves them with it", () => {
    const index = mapIndex();
    index.setImageText(MAP, [line(0, "Ravenhold")]);
    index.setShape(MAP, PAGE_2, []);
    expect(index.search("ravenhold").map((hit) => hit.doc.page)).toEqual([PAGE_2]);
  });

  it("takes no lines for an image it does not hold, and forgets them with the image", () => {
    const index = mapIndex();
    index.setImageText("shape:gone" as TLShapeId, [
      { ...line(0, "Ghost"), shape: "shape:gone" as TLShapeId },
    ]);
    expect(found(index, "ghost")).toEqual([]);
    index.setImageText(MAP, [line(0, "Ravenhold")]);
    index.removeShape(MAP);
    expect(index.size).toBe(0);
  });
});

describe("rich text", () => {
  const text = (value: string, marks?: object[]) => ({ marks, text: value, type: "text" });
  const block = (type: string, ...content: object[]) => ({ content, type });

  it("reads every word, styled or not, with blocks and breaks as spaces", () => {
    const doc = block(
      "doc",
      block("paragraph", text("Gród "), text("Żółwia", [{ type: "bold" }])),
      block("paragraph", text("first"), { type: "hardBreak" }, text("second")),
      block("bulletList", block("listItem", block("paragraph", text("item")))),
    );
    expect(richTextWords(doc)).toBe("Gród Żółwia first second item");
  });

  it("reads nothing from an empty or missing document", () => {
    expect(richTextWords(block("doc", block("paragraph")))).toBe("");
    expect(richTextWords(null)).toBe("");
  });
});

describe("excerpts", () => {
  it("shows a short text whole, the match marked", () => {
    expect(marked(excerpt("Wielki\nŻółw", "zolw", ["zolw"]))).toBe("Wielki [Żółw]");
  });

  it("marks the word a typo or prefix matched", () => {
    expect(marked(excerpt("The Prancing Pony tavern", "tavren", ["tavern"]))).toBe(
      "The Prancing Pony [tavern]",
    );
  });

  it("cuts a long text around its first match, at word edges", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(8);
    const source = `${filler}the hidden Żółw sleeps here ${filler}`;
    const text = marked(excerpt(source, "żółw", ["zolw"]));
    expect(text).toMatch(/^….*\[Żółw\].*…$/u);
    expect(text.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 4);
    const words = new Set(source.split(" "));
    const shown = text.replaceAll(/[…[\]]/gu, "").split(" ");
    expect(shown.filter((word) => !words.has(word))).toEqual([]);
  });

  it("starts a long text at its start when the match is there", () => {
    const text = marked(excerpt(`Żółw ${"x ".repeat(100)}`, "zolw", ["zolw"]));
    expect(text).toMatch(/^\[Żółw\] x x/u);
    expect(text.endsWith("…")).toBe(true);
  });
});
