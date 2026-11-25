import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { type Ref, useEffect, useMemo } from "react";
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
import { BoardLoading } from "./board-loading";
import { BoardMainMenu, components } from "./chrome";
import { type DeckActions, DeckContext } from "./deck";
import { DeckImageUtil } from "./deck-piece";
import { GizmoGeoUtil } from "./gizmo-geo";

import { MEDIA_PROPS } from "./file-flows";
import { PageKeeper } from "./pages";
import { BoardArrowShapeUtil, BoardDrawShapeUtil, BoardGeoShapeUtil } from "./pattern-shapes";
import { PublicArrowBindingUtil, rememberExistingArrows } from "./public-arrow-bindings";
import { PublicBoardIntro } from "./public-landing";
import { useBoardUi } from "./ui";

// WARNING: Keep tldraw fonts, icons, and translations local because the Content-Security-Policy blocks other hosts.
const assetUrls = getAssetUrlsByImport();

function ThemeKeeper() {
  const editor = useEditor();
  const dark = useValue("dark mode", () => editor.user.getIsDarkMode(), [editor]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return null;
}

// WARNING: The Content-Security-Policy blocks external frames, including tldraw embeds for YouTube and Figma links.
const BASE_UTILS = [EmbedShapeUtil.configure({ embedDefinitions: [] }), DeckImageUtil];
const SHAPE_UTILS = [...BASE_UTILS, GizmoGeoUtil];

const LANDING_SHAPE_UTILS = [
  ...BASE_UTILS,
  BoardArrowShapeUtil,
  BoardDrawShapeUtil,
  BoardGeoShapeUtil,
];

const PUBLIC_BINDING_UTILS = [PublicArrowBindingUtil];

export function BoardEditors({
  active,
  editorLayerRef,
  overlay,
  showUi,
  landing,
  licenseKey,
  onEditor,
  secret,
  store,
  deck,
}: {
  active: boolean;
  editorLayerRef: Ref<HTMLDivElement>;
  overlay: boolean;
  showUi: boolean;
  landing?: PublicLanding;
  licenseKey: string;
  onEditor: (editor: Editor | null) => void;
  secret: boolean;
  store: TLStoreWithStatus;
  deck?: DeckActions;
}) {
  const { board, copy, locale: language } = useBoardUi();
  const canvasComponents = useMemo(() => {
    const LoadingScreen = () => <BoardLoading text={copy.loading} />;
    return landing === undefined
      ? { ...components, Background: overlay ? null : BoardBackground, LoadingScreen }
      : {
          ...components,
          Background: () => (
            <>
              <BoardBackground />
              <PublicBoardIntro {...landing} />
            </>
          ),
          LoadingScreen,
          MainMenu: () => <BoardMainMenu hideExit />,
        };
  }, [copy.loading, overlay, landing]);

  // WARNING: Keep the foreground editor isolated so tldraw's z-index 300 UI cannot cover the board's sheets.
  const canvas = (
    <div
      className="absolute inset-0 isolate"
      data-board-editor
      inert={!active}
      ref={editorLayerRef}
    >
      <Tldraw
        {...MEDIA_PROPS}
        assetUrls={assetUrls}
        autoFocus={active}
        bindingUtils={landing === undefined ? undefined : PUBLIC_BINDING_UTILS}
        colorScheme="system"
        components={canvasComponents}
        hideUi={!showUi}
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
  );
  return <DeckContext.Provider value={deck}>{canvas}</DeckContext.Provider>;
}
