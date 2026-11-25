import type { Editor } from "tldraw";

import type { DeckGrid } from "../../src/deck";

type Region = { left: number; right: number; top: number; bottom: number };

function freeViewport(editor: Editor) {
  const container = editor.getContainer();
  const rect = container.getBoundingClientRect();
  const { left, right, bottom } = rect;
  const shell = container.closest("[data-board-shell]");
  const header = shell?.querySelector("[data-practice-header]")?.getBoundingClientRect();
  const top = Math.max(rect.top, header?.bottom ?? rect.top);
  const shelf = shell?.querySelector("[data-gizmo-shelf]")?.getBoundingClientRect();
  if (shelf === undefined || shelf.width === 0 || shelf.height === 0) {
    return { left, right, top, bottom };
  }
  if (shelf.width < rect.width * 0.55 && shelf.height >= rect.height * 0.55) {
    return shelf.left - left > right - shelf.right
      ? { left, right: shelf.left, top, bottom }
      : { left: shelf.right, right, top, bottom };
  }
  return shelf.top - top > bottom - shelf.bottom
    ? { left, right, top, bottom: shelf.top }
    : { left, right, top: shelf.bottom, bottom };
}

function onScreen(editor: Editor) {
  return editor["getCurrentPageShapes"]().flatMap((piece) => {
    const bounds = editor["getShapePageBounds"](piece);
    if (!bounds) return [];
    const first = editor.pageToScreen({ x: bounds.minX, y: bounds.minY });
    const last = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY });
    return [{ left: first.x, right: last.x, top: first.y, bottom: last.y }];
  });
}

const centerIn = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function planGrid(view: Region, rect: DOMRect, stack: Region, obstacles: Region[]) {
  const gap = Math.max(12, rect.height * 0.08);
  const width = rect.width * 1.05;
  const { height } = rect;
  const stepX = width + gap;
  const stepY = height + gap;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + halfHeight;
  const maxColumns = (space: number) => Math.max(0, Math.min(3, Math.floor((space + gap) / stepX)));
  const sideSpace = [
    { ...view, left: Math.max(view.left, stack.right + gap) },
    { ...view, right: Math.min(view.right, stack.left - gap) },
  ].toSorted((a, b) => b.right - b.left - (a.right - a.left));
  const candidates = [
    ...sideSpace,
    { ...view, top: Math.max(view.top, stack.bottom + gap) },
    { ...view, bottom: Math.min(view.bottom, stack.top - gap) },
  ]
    .flatMap((region) => {
      const count = maxColumns(region.right - region.left);
      if (count === 0 || region.bottom - region.top < height) return [];
      const y = centerIn(centerY, region.top + halfHeight, region.bottom - halfHeight);
      return Array.from({ length: count }, (_, index) => {
        const columns = count - index;
        const span = (columns - 1) * stepX;
        const x = centerIn(
          centerX - span / 2,
          region.left + halfWidth,
          region.right - halfWidth - span,
        );
        return { x, y, columns, stepX, stepY };
      });
    })
    .toSorted((a, b) => b.columns - a.columns);

  const firstClear = candidates.find(({ x, y, columns }) =>
    Array.from({ length: columns }, (_, index) => x + index * stepX).every((slot) =>
      obstacles.every(
        ({ left, right, top, bottom }) =>
          slot + halfWidth <= left ||
          slot - halfWidth >= right ||
          y + halfHeight <= top ||
          y - halfHeight >= bottom,
      ),
    ),
  );
  return (
    firstClear ??
    candidates[0] ?? {
      x: view.left + halfWidth,
      y: Math.max(view.top, stack.bottom + gap) + halfHeight,
      columns: 1,
      stepX,
      stepY,
    }
  );
}

export function suggestDeckGrid(editor: Editor, deckRect: DOMRect, topCard: DOMRect) {
  const { left, right, top, bottom } = freeViewport(editor);
  const padding = 14;
  const grid = planGrid(
    { left: left + padding, right: right - padding, top: top + padding, bottom: bottom - padding },
    deckRect,
    {
      top: Math.min(deckRect.top, topCard.top),
      left: Math.min(deckRect.left, topCard.left),
      bottom: Math.max(deckRect.bottom, topCard.bottom),
      right: Math.max(deckRect.right, topCard.right),
    },
    onScreen(editor),
  );
  const corner = editor.screenToPage({ x: grid.x, y: grid.y });
  const zoom = editor.getZoomLevel();
  return {
    x: corner.x,
    y: corner.y,
    columns: grid.columns,
    stepX: grid.stepX / zoom,
    stepY: grid.stepY / zoom,
  } satisfies DeckGrid;
}
