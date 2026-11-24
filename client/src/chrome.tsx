import {
  ArrowToolbarItem,
  AssetToolbarItem,
  DefaultActionsMenu,
  DefaultContextMenu,
  DefaultContextMenuContent,
  DefaultMainMenu,
  DefaultMainMenuContent,
  DefaultQuickActions,
  DefaultToolbar,
  DrawToolbarItem,
  EllipseToolbarItem,
  EraserToolbarItem,
  FrameToolbarItem,
  HandToolbarItem,
  HighlightToolbarItem,
  LaserToolbarItem,
  LineToolbarItem,
  NoteToolbarItem,
  PORTRAIT_BREAKPOINT,
  RectangleToolbarItem,
  SelectToolbarItem,
  StarToolbarItem,
  TextToolbarItem,
  type TLComponents,
  TldrawUiButton,
  TldrawUiMenuActionItem,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  type TLUiContextMenuProps,
  TriangleToolbarItem,
  UndoRedoGroup,
  useBreakpoint,
  useEditor,
  useValue,
} from "tldraw";

import { BoardFileMenuItems } from "./board-files";
import { FoundHighlight } from "./highlight";
import { Icon, type IconName } from "./icons";
import { usePresent } from "./people";
import { placeName, removePlace } from "./places";
import { type Panel, PANEL_ID, useBoardUi } from "./ui";

// The tools a table reaches for, in the order the toolbar shows them until
// it runs out of room and folds the rest into its overflow menu.
function BoardTools() {
  return (
    <>
      <SelectToolbarItem />
      <HandToolbarItem />
      <DrawToolbarItem />
      <TextToolbarItem />
      <EraserToolbarItem />
      <NoteToolbarItem />
      <ArrowToolbarItem />
      <FrameToolbarItem />
      <AssetToolbarItem />
      <RectangleToolbarItem />
      <EllipseToolbarItem />
      <TriangleToolbarItem />
      <StarToolbarItem />
      <LineToolbarItem />
      <HighlightToolbarItem />
      <LaserToolbarItem />
    </>
  );
}

function PanelButton({
  badge,
  icon,
  label,
  panel,
}: {
  badge?: number;
  icon: IconName;
  label: string;
  panel: Panel;
}) {
  const ui = useBoardUi();
  const expanded = ui.panel === panel;
  return (
    <TldrawUiButton
      aria-controls={expanded ? PANEL_ID[panel] : undefined}
      aria-expanded={expanded}
      isActive={expanded}
      onClick={() => ui.open(expanded ? null : panel)}
      title={label}
      type="tool"
    >
      <Icon className="size-4.5" name={icon} />
      {badge !== undefined && badge > 1 && (
        <span
          aria-hidden="true"
          className="absolute! top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-secondary px-1 text-[0.625rem] leading-none font-bold text-white tabular-nums"
        >
          {badge}
        </span>
      )}
    </TldrawUiButton>
  );
}

const TOOLBAR_FIT = { maxItems: 8, maxSizePx: 478, minItems: 1, minSizePx: 177 };
const PHONE_TOOLBAR_FIT = { ...TOOLBAR_FIT, maxItems: 4, minItems: 4 };

const usePhone = () => useBreakpoint() < PORTRAIT_BREAKPOINT.TABLET_SM;

// A phone keeps the row above its tools to undo, redo and delete, so the
// bar fits a 360px screen; duplicate and the arrange menu stay a long press
// away in the context menu.
function BoardQuickActions() {
  const editor = useEditor();
  const phone = usePhone();
  const selected = useValue("has selection", () => editor.getSelectedShapeIds().length > 0, [
    editor,
  ]);
  if (!phone) return <DefaultQuickActions />;
  return (
    <DefaultQuickActions>
      <UndoRedoGroup />
      {selected && <TldrawUiMenuActionItem actionId="delete" />}
    </DefaultQuickActions>
  );
}

function BoardActionsMenu() {
  return usePhone() ? null : <DefaultActionsMenu />;
}

// The board's three controls ride in tldraw's own bottom row, so a phone
// shows one bar: drawing tools first, the table's things at the thumb's end.
// tldraw's toolbar takes the width the controls leave and folds the tools
// that do not fit into its overflow menu. The right edge stays clear for
// tldraw's licence watermark, which must never be covered.
function BoardToolbar() {
  const { copy, editor, person } = useBoardUi();
  const compact = usePhone();
  const people = usePresent(editor).filter(({ id }) => id !== person.id).length + 1;
  return (
    <div
      className="flex w-full min-w-0 grow-2 items-end sm:justify-center [&>.tlui-main-toolbar]:min-w-0 [&>.tlui-main-toolbar]:grow [&>.tlui-main-toolbar]:basis-0 sm:[&>.tlui-main-toolbar]:justify-end sm:[&>.tlui-main-toolbar]:grow-0 sm:[&>.tlui-main-toolbar]:basis-[483px]"
      data-board-toolbar={compact ? "compact" : ""}
    >
      <DefaultToolbar {...(compact ? PHONE_TOOLBAR_FIT : TOOLBAR_FIT)}>
        <BoardTools />
      </DefaultToolbar>
      {/* oxlint-disable-next-line better-tailwindcss/no-unknown-classes -- the drawing toolbar's tldraw surface */}
      <div className="tlui-main-toolbar__tools flex shrink-0" data-board-toolbar-actions>
        <PanelButton icon="MagnifyingGlass" label={copy.search} panel="search" />
        <PanelButton badge={people} icon="Group" label={copy.people} panel="people" />
        <PanelButton icon="Dice" label={copy.dice} panel="dice" />
      </div>
    </div>
  );
}

function PlaceMenuItems() {
  const editor = useEditor();
  const { copy, open, setNaming } = useBoardUi();
  const only = useValue(
    "only selected shape",
    () => {
      const shapes = editor.getSelectedShapes();
      return shapes.length === 1 ? shapes[0]! : null;
    },
    [editor],
  );
  if (only === null) return null;
  const isPlace = placeName(only) !== null;
  return (
    <TldrawUiMenuGroup id="board-places">
      {isPlace ? (
        <TldrawUiMenuItem
          id="board-remove-place"
          label={copy.removePlace}
          onSelect={() => removePlace(editor, only.id)}
        />
      ) : (
        <TldrawUiMenuItem
          id="board-add-place"
          label={copy.addToPlaces}
          onSelect={() => {
            setNaming(only.id);
            open("search");
          }}
        />
      )}
    </TldrawUiMenuGroup>
  );
}

// tldraw's menu, with the way out of the board on top.
export function BoardMainMenu({ hideExit = false }: { hideExit?: boolean }) {
  const { exit } = useBoardUi();
  return (
    <DefaultMainMenu>
      {!hideExit && (
        <TldrawUiMenuGroup id="board-exit">
          <TldrawUiMenuItem
            id="board-exit"
            label={exit.label}
            onSelect={() => location.assign(exit.href)}
          />
        </TldrawUiMenuGroup>
      )}
      <BoardFileMenuItems />
      <DefaultMainMenuContent />
    </DefaultMainMenu>
  );
}

function BoardContextMenu(props: TLUiContextMenuProps) {
  return (
    <DefaultContextMenu {...props}>
      <PlaceMenuItems />
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  );
}

// What stays of tldraw's own interface, and why the rest goes:
// - The page menu stays beside the main menu in the top corner, on a phone
//   too: the bottom bar is the table's, and pages are switched far less
//   often than tools.
// - SharePanel: the people sheet replaces it; tldraw's own lets each person
//   rename or recolour themselves, but the name comes from the pass.
// - TopPanel: its offline badge is replaced by the board's own, in the
//   board's language.
// - On a phone, duplicate and the arrange menu leave the bar (see
//   BoardQuickActions).
// In front of the canvas: the flash of a chosen search result.
export const components: TLComponents = {
  ActionsMenu: BoardActionsMenu,
  ContextMenu: BoardContextMenu,
  InFrontOfTheCanvas: FoundHighlight,
  MainMenu: () => <BoardMainMenu />,
  QuickActions: BoardQuickActions,
  SharePanel: null,
  Toolbar: BoardToolbar,
  TopPanel: null,
};
