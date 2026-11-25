// tldraw builds hatch tiles for every zoom level and both themes the first
// time these SVG defs mount. Keep its renderer, but wait for a patterned
// shape (local or remote), or for the user to select the pattern fill.
import {
  ArrowShapeUtil,
  computed,
  DefaultFillStyle,
  DrawShapeUtil,
  type Editor,
  GeoShapeUtil,
  RESET_VALUE,
  type TLShape,
  WeakCache,
} from "tldraw";

const patterned = (shape: TLShape) => "fill" in shape.props && shape.props.fill === "pattern";

function watchPattern(editor: Editor) {
  const history = editor.store.query.filterHistory("shape");
  return computed<boolean>("board pattern fills", (previous, epoch) => {
    if (previous === true || editor.getStyleForNextShape(DefaultFillStyle) === "pattern")
      return true;
    const changes = history.getDiffSince(epoch);
    if (typeof previous !== "boolean" || changes === RESET_VALUE) {
      return editor.store.query.records("shape").get().some(patterned);
    }
    return changes.some(
      (diff) =>
        Object.values(diff.added).some(patterned) ||
        Object.values(diff.updated).some(([, shape]) => patterned(shape)),
    );
  });
}

const patterns = new WeakCache<Editor, ReturnType<typeof watchPattern>>();

// WARNING: All three stock providers share this SVG definition. Leaving even one eager mounts the pattern tiles.
export class BoardDrawShapeUtil extends DrawShapeUtil {
  override getCanvasSvgDefs() {
    return patterns.get(this.editor, watchPattern).get() ? super.getCanvasSvgDefs() : [];
  }
}

export class BoardGeoShapeUtil extends GeoShapeUtil {
  override getCanvasSvgDefs() {
    return patterns.get(this.editor, watchPattern).get() ? super.getCanvasSvgDefs() : [];
  }
}

export class BoardArrowShapeUtil extends ArrowShapeUtil {
  override getCanvasSvgDefs() {
    return patterns.get(this.editor, watchPattern).get() ? super.getCanvasSvgDefs() : [];
  }
}
