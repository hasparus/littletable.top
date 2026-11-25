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

import { BoardBackgroundMenu } from "./board-background";
import { BoardFileMenuItems } from "./board-files";
import { RenameBoardItem } from "./board-name";
import { useFeedback } from "./feedback";
import { FoundHighlight } from "./highlight";
import { Icon, type IconName } from "./icons";
import { usePresent } from "./people";
import { placeName, removePlace } from "./places";
import { type Panel, PANEL_ID, useBoardUi } from "./ui";

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

// WARNING: Reserve the toolbar's right edge for tldraw's licence watermark.
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

export function BoardMainMenu({ hideExit = false }: { hideExit?: boolean }) {
  const { canPlaceGizmos, copy, exit, open, person } = useBoardUi();
  const feedback = useFeedback();
  const editor = useEditor();
  return (
    <DefaultMainMenu>
      {!hideExit && (
        <TldrawUiMenuGroup id="board-exit">
          <RenameBoardItem />
          <TldrawUiMenuItem
            id="board-exit"
            label={exit.label}
            onSelect={() => location.assign(exit.href)}
          />
        </TldrawUiMenuGroup>
      )}
      {canPlaceGizmos && (
        <TldrawUiMenuGroup id="board-gizmos">
          <TldrawUiMenuItem id="open-gizmos" label={copy.gizmos} onSelect={() => open("gizmos")} />
        </TldrawUiMenuGroup>
      )}
      <BoardFileMenuItems />
      <BoardBackgroundMenu />
      <DefaultMainMenuContent />
      {feedback !== null && (
        <TldrawUiMenuGroup id="board-feedback">
          <TldrawUiMenuItem
            id="send-feedback"
            label={feedback.label}
            onSelect={() =>
              feedback.open(
                { role: person.id.startsWith("g:") ? "guest" : "member", screen: "board" },
                // WARNING: Return focus to the trigger because tldraw unmounts the selected item when the menu closes.
                editor
                  .getContainer()
                  .querySelector<HTMLElement>('[data-testid="main-menu.button"]'),
              )
            }
          />
        </TldrawUiMenuGroup>
      )}
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
