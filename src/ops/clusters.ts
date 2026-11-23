import type { TLPageId, TLShape } from "@tldraw/tlschema";

import type { Doc } from "./doc";

import { type Box, pageBounds, union } from "./geometry";
import { fromShapeId, textOf } from "./records";

// What get_page_info reports: a page's shapes gathered into clusters a
// reader would call "that group over there". Our own method, on records
// and our geometry alone:
//
// 1. An atom is a top-level shape with everything inside it (a frame or a
//    group and its children count as one).
// 2. An arrow joins the atoms it is bound to.
// 3. Atoms whose boxes are closer than `reach` join. `reach` follows the
//    page: half the median atom's shorter side, between 40 and 160 px. A
//    grid of `reach`-sized cells finds neighbours without comparing all pairs.
// 4. A cluster is named by the words that are frequent in it and rare on
//    the rest of the page.

export type Cluster = {
  bounds: Box;
  id: string;
  keywords: string[];
  label: string;
  numberOfShapes: number;
  shapeIds: string[];
};

const MIN_REACH = 40;
const MAX_REACH = 160;
const KEYWORDS = 5;

class Sets {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[index] !== root) {
      const next = this.parent[index]!;
      this.parent[index] = root;
      index = next;
    }
    return root;
  }

  join(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

const gap = (a: Box, b: Box) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);

// A short, stable name: the same shapes give the same cluster id.
function idOf(shapeIds: string[]): string {
  let hash = 2_166_136_261;
  for (const char of [...shapeIds].sort().join("|")) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16_777_619);
  }
  return `c${Math.abs(hash).toString(36)}`;
}

export function clustersOf(doc: Doc, pageId: TLPageId): Cluster[] {
  const atoms = doc.children(pageId);
  const boxes = atoms.map((shape) => pageBounds(doc, shape));
  const atomOf = new Map<string, number>();
  for (const [index, atom] of atoms.entries()) {
    atomOf.set(atom.id, index);
    for (const child of doc.descendants(atom.id)) atomOf.set(child.id, index);
  }
  const sets = new Sets(atoms.length);

  for (const [index, atom] of atoms.entries()) {
    if (atom.type !== "arrow") continue;
    for (const binding of doc.bindingsOf(atom.id)) {
      const other = atomOf.get(binding.toId);
      if (other !== undefined) sets.join(index, other);
    }
  }

  const sides = boxes.map((box) => Math.min(box.w, box.h)).sort((a, b) => a - b);
  const median = sides[sides.length >> 1] ?? MIN_REACH;
  const reach = Math.min(MAX_REACH, Math.max(MIN_REACH, median / 2));
  const cells = new Map<string, number[]>();
  for (const [index, box] of boxes.entries()) {
    // NOTE: arrows already joined what they bind; their long thin boxes
    // would otherwise chain distant groups together.
    if (atoms[index]!.type === "arrow") continue;
    const x0 = Math.floor((box.x - reach) / reach);
    const x1 = Math.floor((box.x + box.w + reach) / reach);
    const y0 = Math.floor((box.y - reach) / reach);
    const y1 = Math.floor((box.y + box.h + reach) / reach);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const cell = cells.get(key);
        if (cell === undefined) {
          cells.set(key, [index]);
          continue;
        }
        for (const other of cell) {
          if (sets.find(other) !== sets.find(index) && gap(box, boxes[other]!) <= reach) {
            sets.join(index, other);
          }
        }
        cell.push(index);
      }
    }
  }

  const members = new Map<number, number[]>();
  for (const index of atoms.keys()) {
    const root = sets.find(index);
    members.set(root, [...(members.get(root) ?? []), index]);
  }

  const groups = [...members.values()].map((indexes) => {
    const shapes: TLShape[] = indexes.flatMap((index) => [
      atoms[index]!,
      ...doc.descendants(atoms[index]!.id),
    ]);
    const counts = new Map<string, number>();
    for (const shape of shapes) {
      for (const word of words(textOf(shape))) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return { bounds: union(indexes.map((index) => boxes[index]!))!, counts, shapes };
  });
  const spread = new Map<string, number>();
  for (const { counts } of groups) {
    for (const word of counts.keys()) spread.set(word, (spread.get(word) ?? 0) + 1);
  }

  return groups
    .map(({ bounds, counts, shapes }) => {
      const keywords = [...counts]
        .map(([word, count]) => ({
          score: count * Math.log(1 + groups.length / spread.get(word)!),
          word,
        }))
        .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
        .slice(0, KEYWORDS)
        .map(({ word }) => word);
      const shapeIds = shapes.map((shape) => fromShapeId(shape.id));
      return {
        bounds: {
          h: Math.round(bounds.h),
          w: Math.round(bounds.w),
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
        },
        id: idOf(shapeIds),
        keywords,
        label: keywords.slice(0, 3).join(" ") || `${shapes.length} shapes without text`,
        numberOfShapes: shapes.length,
        shapeIds,
      };
    })
    .sort((a, b) => b.numberOfShapes - a.numberOfShapes || a.id.localeCompare(b.id));
}
