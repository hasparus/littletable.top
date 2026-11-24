import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  DefaultBackground,
  type Editor,
  EmbedShapeUtil,
  Tldraw,
  type TLStoreWithStatus,
  useEditor,
  useValue,
} from "tldraw";

import type { PublicLanding } from "./public-landing";

import { BoardFileHandlers } from "./board-files";
import { BoardMainMenu, components } from "./chrome";
import { MEDIA_PROPS } from "./file-flows";
import { PageKeeper } from "./pages";
import { PublicArrowBindingUtil, rememberExistingArrows } from "./public-arrow-bindings";
import { PublicBoardIntro } from "./public-landing";
import { type SharedView, useSharedBackdrop } from "./secret-backdrop";
import { useBoardUi } from "./ui";

// NOTE: fonts, icons and tldraw's own translations ship in our build: the
// Content-Security-Policy allows no host but ours.
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

// A pasted YouTube or Figma link would become a frame onto that site, which
// the Content-Security-Policy refuses; it stays a plain link instead.
const SHAPE_UTILS = [EmbedShapeUtil.configure({ embedDefinitions: [] })];

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
          ? components
          : { ...components, Background: null }
        : {
            ...components,
            Background: () => (
              <>
                <DefaultBackground />
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
      {/* NOTE: isolate keeps tldraw's own layers (its UI sits at z-index 300) under the board's sheets. */}
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
            // NOTE: tldraw's own menus (the page menu's among them) take
            // their language from the person's preferences, not this prop.
            mounted.user.updateUserPreferences({ locale: language });
            if (landing !== undefined) rememberExistingArrows(mounted);
            onEditor(mounted);
            return () => onEditor(null);
          }}
          shapeUtils={SHAPE_UTILS}
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
