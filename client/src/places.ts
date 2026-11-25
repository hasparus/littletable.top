import { useCallback, useState } from "react";
import {
  Box,
  type BoxLike,
  type Editor,
  type IndexKey,
  type TLPageId,
  type TLShape,
  type TLShapeId,
} from "tldraw";

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

function openPlacePage(editor: Editor, page: TLPageId) {
  const away = page !== editor.getCurrentPageId();
  if (editor.getInstanceState().followingUserId !== null) editor.stopFollowingUser();
  if (away) {
    editor.markHistoryStoppingPoint("change-page");
    editor.setCurrentPage(page);
  }
  // WARNING: On a page switch, an animated zoom would start at that page's old camera position.
  return away ? undefined : { duration: editor.options.animationMediumMs };
}

const PLACE_INSET = 32;

export function goToBounds(editor: Editor, page: TLPageId, bounds: BoxLike): void {
  editor.zoomToBounds(bounds, {
    animation: openPlacePage(editor, page),
    inset: PLACE_INSET,
    targetZoom: 1,
  });
}

function canvasBesideIndex(screen: Box, index: DOMRectReadOnly): Box {
  const viewport = globalThis.visualViewport;
  const left = Math.max(screen.x, viewport?.offsetLeft ?? 0);
  const top = Math.max(screen.y, viewport?.offsetTop ?? 0);
  const right = Math.min(
    screen.maxX,
    (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
  );
  const bottom = Math.min(
    screen.maxY,
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
  );
  const above = new Box(left, top, right - left, Math.max(0, Math.min(bottom, index.top) - top));
  const rightOf = Math.max(left, index.right);
  const beside = new Box(rightOf, top, Math.max(0, right - rightOf), bottom - top);
  return above.w * above.h > beside.w * beside.h ? above : beside;
}

export function goToPlace(editor: Editor, id: TLShapeId, index: DOMRectReadOnly | undefined): void {
  const page = editor.getAncestorPageId(id);
  const bounds = editor.getShapePageBounds(id);
  if (page === undefined || bounds === undefined) return;
  const screen = editor.getViewportScreenBounds();
  const available = index === undefined ? screen : canvasBesideIndex(screen, index);
  if (available.w <= PLACE_INSET || available.h <= PLACE_INSET) {
    goToBounds(editor, page, bounds);
    return;
  }
  const animation = openPlacePage(editor, page);
  const { zoomSteps } = editor.getCameraOptions();
  const base = editor.getBaseZoom();
  const z = Math.max(
    zoomSteps[0]! * base,
    Math.min(
      1,
      zoomSteps.at(-1)! * base,
      (available.w - PLACE_INSET) / bounds.w,
      (available.h - PLACE_INSET) / bounds.h,
    ),
  );
  editor.setCamera(
    {
      x: (available.midX - screen.x) / z - bounds.midX,
      y: (available.midY - screen.y) / z - bounds.midY,
      z,
    },
    { animation },
  );
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
        // WARNING: A browser can block localStorage. Retain the star in memory if the write fails.
      }
    },
    [key],
  );
  return [mine, choose];
}

const byPage = (a: Place, b: Place) =>
  a.pageIndex < b.pageIndex ? -1 : a.pageIndex > b.pageIndex ? 1 : 0;

export function ordered(places: Place[], mine: TLShapeId | null, locale: string) {
  return places.toSorted(
    (a, b) =>
      Number(b.id === mine) - Number(a.id === mine) ||
      byPage(a, b) ||
      a.name.localeCompare(b.name, locale),
  );
}
