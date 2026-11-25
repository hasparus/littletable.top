import {
  type Editor,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  useEditor,
  useValue,
} from "tldraw";

import type { Copy } from "./copy";

import { isSecretLayer } from "../../src/secret-layer";
import { useBoardUi } from "./ui";

const PALETTE = {
  default: { label: "boardBackgroundDefault", surface: "bg-(--tl-color-background)" },
  lilac: { label: "boardBackgroundLilac", surface: "bg-[#f0e9f7] dark:bg-[#33283d]" },
  sage: { label: "boardBackgroundSage", surface: "bg-[#e8f0e3] dark:bg-[#253126]" },
  sand: { label: "boardBackgroundSand", surface: "bg-[#f6eedc] dark:bg-[#342c20]" },
  sky: { label: "boardBackgroundSky", surface: "bg-[#e6eff9] dark:bg-[#222d3d]" },
} as const satisfies Record<string, { label: keyof Copy; surface: string }>;

function boardColor(editor: Editor): keyof typeof PALETTE {
  const color = editor.getDocumentSettings().meta.backgroundColor;
  return typeof color === "string" && Object.hasOwn(PALETTE, color)
    ? (color as keyof typeof PALETTE)
    : "default";
}

export function BoardBackground() {
  const editor = useEditor();
  const color = useValue("board background", () => boardColor(editor), [editor]);
  return <div className={`size-full ${PALETTE[color].surface}`} data-board-background={color} />;
}

export function BoardBackgroundMenu() {
  const { board, copy } = useBoardUi();
  const editor = useEditor();
  const color = useValue("board background", () => boardColor(editor), [editor]);
  const readonly = useValue("read-only board", () => editor.getIsReadonly(), [editor]);
  if (readonly || isSecretLayer(board)) return null;

  return (
    <TldrawUiMenuGroup id="board-appearance">
      <TldrawUiMenuSubmenu id="board-background" label={copy.boardBackground}>
        {Object.entries(PALETTE).map(([name, { label }]) => (
          <TldrawUiMenuCheckboxItem
            checked={color === name}
            id={name}
            key={name}
            label={copy[label]}
            onSelect={() => {
              const { meta } = editor.getDocumentSettings();
              editor.updateDocumentSettings({ meta: { ...meta, backgroundColor: name } });
            }}
          />
        ))}
      </TldrawUiMenuSubmenu>
    </TldrawUiMenuGroup>
  );
}
