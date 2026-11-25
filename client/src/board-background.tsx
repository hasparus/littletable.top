import { useEffect } from "react";
import {
  type Editor,
  react,
  TldrawUiDropdownMenuCheckboxItem,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  useColorMode,
  useEditor,
  useValue,
} from "tldraw";

import { isBoardColor, PALETTE } from "../../src/board-palette";
import { isSecretLayer } from "../../src/secret-layer";
import { useBoardUi } from "./ui";

function boardColor(editor: Editor) {
  const color = editor.getDocumentSettings().meta.backgroundColor;
  return isBoardColor(color) ? color : "default";
}

export function BoardBackground() {
  const mode = useColorMode();
  const editor = useEditor();
  const color = useValue("board background", () => boardColor(editor), [editor]);
  useEffect(() => {
    // WARNING: Updating the canvas component alone does not change the background on image exports.
    const theme = editor.getCurrentTheme();
    return react("export background", () => {
      const selected = boardColor(editor);
      const { dark, light } = theme.colors;
      editor.updateTheme({
        ...theme,
        colors:
          selected === "default"
            ? theme.colors
            : {
                dark: { ...dark, background: PALETTE[selected].dark },
                light: { ...light, background: PALETTE[selected].light },
              },
      });
    });
  }, [editor]);
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
              data-isactive={color === name}
              key={name}
              onSelect={() => {
                const { meta } = editor.getDocumentSettings();
                editor.updateDocumentSettings({ meta: { ...meta, backgroundColor: name } });
              }}
              title={copy[option.label]}
            >
              <span className="sr-only">{copy[option.label]}</span>
              <span
                aria-hidden="true"
                data-board-background-swatch
                style={{ backgroundColor: option[mode] }}
              />
            </TldrawUiDropdownMenuCheckboxItem>
          ))}
        </div>
      </TldrawUiMenuSubmenu>
    </TldrawUiMenuGroup>
  );
}
