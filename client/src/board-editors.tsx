import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  type Editor,
  EmbedShapeUtil,
  Tldraw,
  type TLStoreWithStatus,
  useEditor,
  useValue,
} from "tldraw";

import type { PublicLanding } from "./public-landing";

import { BoardBackground } from "./board-background";
import { BoardFileHandlers } from "./board-files";
import { BoardMainMenu, components } from "./chrome";
import { MEDIA_PROPS } from "./file-flows";
import { PageKeeper } from "./pages";
import { BoardArrowShapeUtil, BoardDrawShapeUtil, BoardGeoShapeUtil } from "./pattern-shapes";
import { PublicArrowBindingUtil, rememberExistingArrows } from "./public-arrow-bindings";
import { PublicBoardIntro } from "./public-landing";
import { type SharedView, useSharedBackdrop } from "./secret-backdrop";
import { useBoardUi } from "./ui";

// WARNING: Keep tldraw fonts, icons, and translations local because the Content-Security-Policy blocks other hosts.
const assetUrls = getAssetUrlsByImport();

// The board's own sheets and bars take tldraw's theme: the device's until
// the person picks one in tldraw's preferences.
function ThemeKeeper() {
  const editor = useEditor();
  const dark = useValue("dark mode", () => editor.user.getIsDarkMode(), [editor]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return null;
}

// WARNING: The Content-Security-Policy blocks external frames, including tldraw embeds for YouTube and Figma links.
const SHAPE_UTILS = [EmbedShapeUtil.configure({ embedDefinitions: [] })];

const LANDING_SHAPE_UTILS = [
  ...SHAPE_UTILS,
  BoardArrowShapeUtil,
  BoardDrawShapeUtil,
  BoardGeoShapeUtil,
];

const PUBLIC_BINDING_UTILS = [PublicArrowBindingUtil];

export function BoardEditors({
  active,
  backdrop,
  landing,
  licenseKey,
  onEditor,
  onLayerFull,
  secret,
  store,
}: {
  active: boolean;
  backdrop?: SharedView;
  landing?: PublicLanding;
  licenseKey: string;
  onEditor: (editor: Editor | null) => void;
  onLayerFull?: () => void;
  secret: boolean;
  store: TLStoreWithStatus;
}) {
  const { board, copy, editor, locale: language } = useBoardUi();
  useLayoutEffect(() => {
    if (editor === null || backdrop === undefined) return;
    const { camera, page } = backdrop;
    if (editor.getPage(page.id) === undefined) {
      if (editor.getPages().length >= editor.options.maxPages) {
        onLayerFull?.();
        return;
      }
      editor.createPage({ id: page.id, name: page.name });
    }
    editor.setCurrentPage(page.id);
    editor.setCamera(camera, { immediate: true });
  }, [backdrop, editor, onLayerFull]);
  const setBackdropEditor = useSharedBackdrop(editor);
  const canvasComponents = useMemo(
    () =>
      landing === undefined
        ? backdrop === undefined
          ? { ...components, Background: BoardBackground }
          : { ...components, Background: null }
        : {
            ...components,
            Background: () => (
              <>
                <BoardBackground />
                <PublicBoardIntro {...landing} />
              </>
            ),
            MainMenu: () => <BoardMainMenu hideExit />,
          },
    [backdrop, landing],
  );

  return (
    <>
      {backdrop !== undefined && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          data-board-editor
          inert
        >
          <Tldraw
            assetUrls={assetUrls}
            autoFocus={false}
            colorScheme="system"
            components={{ Background: BoardBackground }}
            hideUi
            licenseKey={licenseKey === "" ? undefined : licenseKey}
            locale={language}
            onMount={(mounted) => {
              mounted.updateInstanceState({ isReadonly: true });
              mounted.setCurrentPage(backdrop.page.id);
              mounted.setCamera(backdrop.camera);
              setBackdropEditor(mounted);
              return () => setBackdropEditor(null);
            }}
            shapeUtils={SHAPE_UTILS}
            store={backdrop.store}
          />
        </div>
      )}
      {/* WARNING: Without isolate, tldraw's z-index 300 UI can cover the board's sheets. */}
      <div className="absolute inset-0 isolate" data-board-editor>
        <Tldraw
          {...MEDIA_PROPS}
          assetUrls={assetUrls}
          autoFocus={active}
          bindingUtils={landing === undefined ? undefined : PUBLIC_BINDING_UTILS}
          colorScheme="system"
          components={canvasComponents}
          hideUi={!active}
          licenseKey={licenseKey === "" ? undefined : licenseKey}
          locale={language}
          onMount={(mounted) => {
            // WARNING: tldraw's menus read the user preference rather than the locale prop.
            mounted.user.updateUserPreferences({ locale: language });
            if (landing !== undefined) rememberExistingArrows(mounted);
            onEditor(mounted);
            return () => onEditor(null);
          }}
          shapeUtils={landing ? LANDING_SHAPE_UTILS : SHAPE_UTILS}
          store={store}
        >
          {active && <BoardFileHandlers />}
          {landing === undefined && !secret && <PageKeeper board={board} copy={copy} />}
          <ThemeKeeper />
        </Tldraw>
      </div>
    </>
  );
}
