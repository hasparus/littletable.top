import {
  type Editor,
  TldrawUiButtonIcon,
  TldrawUiDropdownMenuCheckboxItem,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  useColorMode,
  useEditor,
  useValue,
} from "tldraw";

import type { Copy } from "./copy";

import { isSecretLayer } from "../../src/secret-layer";
import { useBoardUi } from "./ui";

const PALETTE = {
  default: {
    dark: "var(--tl-color-background)",
    label: "boardBackgroundDefault",
    light: "var(--tl-color-background)",
  },
  lilac: { dark: "#33283d", label: "boardBackgroundLilac", light: "#f0e9f7" },
  sage: { dark: "#2c2f2a", label: "boardBackgroundSage", light: "#ebede7" },
  sand: { dark: "#342c20", label: "boardBackgroundSand", light: "#f6eedc" },
  sky: { dark: "#222d3d", label: "boardBackgroundSky", light: "#e6eff9" },
} as const satisfies Record<string, { dark: string; label: keyof Copy; light: string }>;

function boardColor(editor: Editor): keyof typeof PALETTE {
  const color = editor.getDocumentSettings().meta.backgroundColor;
  return typeof color === "string" && Object.hasOwn(PALETTE, color)
    ? (color as keyof typeof PALETTE)
    : "default";
}

export function BoardBackground() {
  const mode = useColorMode();
  const editor = useEditor();
  const color = useValue("board background", () => boardColor(editor), [editor]);
  return (
    <div
      className="size-full"
      data-board-background={color}
      style={{ backgroundColor: PALETTE[color][mode] }}
    />
  );
}

export function BoardBackgroundMenu() {
  const { board, copy } = useBoardUi();
  const mode = useColorMode();
  const editor = useEditor();
  const color = useValue("board background", () => boardColor(editor), [editor]);
  const readonly = useValue("read-only board", () => editor.getIsReadonly(), [editor]);
  if (readonly || isSecretLayer(board)) return null;

  return (
    <TldrawUiMenuGroup id="board-appearance">
      <TldrawUiMenuSubmenu id="board-background" label={copy.boardBackground}>
        <div data-board-background-swatches>
          {Object.entries(PALETTE).map(([name, option]) => (
            <TldrawUiDropdownMenuCheckboxItem
              checked={color === name}
              key={name}
              onSelect={() => {
                const { meta } = editor.getDocumentSettings();
                editor.updateDocumentSettings({ meta: { ...meta, backgroundColor: name } });
              }}
              title={copy[option.label]}
            >
              <span className="sr-only">{copy[option.label]}</span>
              <span aria-hidden="true" style={{ color: option[mode] }}>
                <TldrawUiButtonIcon icon="color" />
              </span>
            </TldrawUiDropdownMenuCheckboxItem>
          ))}
        </div>
      </TldrawUiMenuSubmenu>
    </TldrawUiMenuGroup>
  );
}
