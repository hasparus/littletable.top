import { ArrowBindingUtil, type Editor, getArrowInfo, type TLShapeId } from "tldraw";

import { saveArrowEndpoints } from "../../src/public-arrow-endpoints";

function rememberArrow(editor: Editor, id: TLShapeId): void {
  const arrow = editor.getShape(id);
  if (arrow?.type !== "arrow") return;
  const bindings = editor.getBindingsFromShape(id, "arrow");
  if (bindings.length === 0) return;
  const info = getArrowInfo(editor, arrow);
  if (info === undefined) return;

  // Store the editor's resolved endpoints while their targets still exist.
  // They are in the arrow's own coordinates and survive reparenting.
  const meta = saveArrowEndpoints(arrow, {
    end: bindings.some(({ props }) => props.terminal === "end") ? info.end.point : undefined,
    start: bindings.some(({ props }) => props.terminal === "start") ? info.start.point : undefined,
  });
  if (meta !== null)
    editor.run(() => editor.updateShape({ id, meta, type: "arrow" }), { history: "ignore" });
}

export function rememberExistingArrows(editor: Editor): void {
  editor.run(
    () => {
      for (const record of editor.store.allRecords()) {
        if (record.typeName === "shape" && record.type === "arrow")
          rememberArrow(editor, record.id);
      }
    },
    { history: "ignore" },
  );
}

// Keep the snapshot current through the same binding events that tldraw uses
// to recompute arrow geometry, including changes to ancestors.
export class PublicArrowBindingUtil extends ArrowBindingUtil {
  override onAfterCreate(options: Parameters<ArrowBindingUtil["onAfterCreate"]>[0]): void {
    super.onAfterCreate(options);
    rememberArrow(this.editor, options.binding.fromId);
  }

  override onAfterChange(options: Parameters<ArrowBindingUtil["onAfterChange"]>[0]): void {
    super.onAfterChange(options);
    rememberArrow(this.editor, options.bindingAfter.fromId);
  }

  override onAfterChangeFromShape(
    options: Parameters<ArrowBindingUtil["onAfterChangeFromShape"]>[0],
  ): void {
    super.onAfterChangeFromShape(options);
    rememberArrow(this.editor, options.binding.fromId);
  }

  override onAfterChangeToShape(
    options: Parameters<ArrowBindingUtil["onAfterChangeToShape"]>[0],
  ): void {
    super.onAfterChangeToShape(options);
    rememberArrow(this.editor, options.binding.fromId);
  }
}
