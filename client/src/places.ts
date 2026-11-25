import type { BoxLike, Editor, IndexKey, TLPageId, TLShape, TLShapeId } from "tldraw";

import { useCallback, useState } from "react";

// A place is a shape whose meta carries a name, so tldraw sync shares it
// like any other property, it follows the shape (to another page too: tldraw
// moves a shape there under its own id), and it goes with the shape or its
// page.
const PLACE_KEY = "place";
export const MAX_PLACE_NAME = 60;

export type Place = { id: TLShapeId; name: string; page: TLPageId; pageIndex: IndexKey };

export const placeName = (shape: TLShape): string | null => {
  const name = shape.meta[PLACE_KEY];
  return typeof name === "string" && name.length > 0 ? name : null;
};

export function placesOn(editor: Editor): Place[] {
  return editor.getPages().flatMap((page) =>
    [...editor.getPageShapeIds(page)].flatMap((id) => {
      const shape = editor.getShape(id);
      const name = shape === undefined ? null : placeName(shape);
      return name === null ? [] : [{ id, name, page: page.id, pageIndex: page.index }];
    }),
  );
}

/**
 * What a new place is called before anyone types: a frame's own name, else
 * nothing, so the field shows its placeholder.
 */
export function suggestedName(shape: TLShape): string {
  const props = shape.props as { name?: unknown };
  return shape.type === "frame" && typeof props.name === "string" ? props.name : "";
}

function setMeta(editor: Editor, id: TLShapeId, name: string | null): void {
  const shape = editor.getShape(id);
  if (shape === undefined) return;
  const { [PLACE_KEY]: _previous, ...meta } = shape.meta;
  // WARNING: Allow naming locked shapes without unlocking them. Maps often serve as a fixed background.
  editor.run(
    () => {
      editor.updateShape({
        id,
        meta: name === null ? meta : { ...meta, [PLACE_KEY]: name },
        type: shape.type,
      });
    },
    { ignoreShapeLock: true },
  );
}

export const nameAsPlace = (editor: Editor, id: TLShapeId, name: string) =>
  setMeta(editor, id, name.trim().slice(0, MAX_PLACE_NAME));

export const removePlace = (editor: Editor, id: TLShapeId) => setMeta(editor, id, null);

export function goToBounds(editor: Editor, page: TLPageId, bounds: BoxLike): void {
  const away = page !== editor.getCurrentPageId();
  if (editor.getInstanceState().followingUserId !== null) editor.stopFollowingUser();
  if (away) {
    editor.markHistoryStoppingPoint("change-page");
    editor.setCurrentPage(page);
  }
  editor.zoomToBounds(bounds, {
    // WARNING: On a page switch, an animated zoom would start at that page's old camera position.
    animation: away ? undefined : { duration: editor.options.animationMediumMs },
    inset: 32,

    targetZoom: 1,
  });
}

export function goTo(editor: Editor, id: TLShapeId): void {
  const page = editor.getAncestorPageId(id);
  const bounds = editor.getShapePageBounds(id);
  if (page === undefined || bounds === undefined) return;
  goToBounds(editor, page, bounds);
}

/**
 * The one place each person keeps first in their own list. Private to this
 * browser; storage may be off (private mode), and then the star lasts the visit.
 */
export function useMyPlace(board: string): [TLShapeId | null, (id: TLShapeId | null) => void] {
  const key = `board:${board}:my-place`;
  const [mine, setMine] = useState<TLShapeId | null>(() => {
    try {
      return localStorage.getItem(key) as TLShapeId | null;
    } catch {
      return null;
    }
  });
  const choose = useCallback(
    (id: TLShapeId | null) => {
      setMine(id);
      try {
        if (id === null) localStorage.removeItem(key);
        else localStorage.setItem(key, id);
      } catch {
        // NOTE: storage refused; the star still holds for this visit.
      }
    },
    [key],
  );
  return [mine, choose];
}

const byPage = (a: Place, b: Place) =>
  a.pageIndex < b.pageIndex ? -1 : a.pageIndex > b.pageIndex ? 1 : 0;

export function ordered(places: Place[], mine: TLShapeId | null, locale: string): Place[] {
  return places.toSorted(
    (a, b) =>
      Number(b.id === mine) - Number(a.id === mine) ||
      byPage(a, b) ||
      a.name.localeCompare(b.name, locale),
  );
}
