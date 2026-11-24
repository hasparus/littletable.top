import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { type Editor, EmbedShapeUtil, Tldraw, useEditor, useValue } from "tldraw";

import "./board.css";

import type { Exit } from "./board";
import type { PassKeeper } from "./bootstrap";
import type { Copy } from "./copy";

import { BoardFiles } from "./assets";
import { BoardFileHandlers } from "./board-files";
import { BoardMainMenu, components } from "./chrome";
import { colorFor } from "./colors";
import { DiceSheet, rollSentence } from "./dice";
import { MEDIA_PROPS } from "./file-flows";
import { FoundHighlight, makeHighlight } from "./highlight";
import { ImageText } from "./image-text";
import { Notice } from "./notice";
import { PageKeeper } from "./pages";
import { PeopleSheet } from "./people";
import { PublicBoardIntro, type PublicLanding } from "./public-landing";
import { useRolls } from "./rolls";
import { BoardSearch } from "./search-board";
import { SEARCH_FIELD_ID, SearchSheet } from "./search-sheet";
import { useBoardStore } from "./sync";
import { textEngines } from "./text-support";
import { type BoardUi, BoardUiContext, type Panel } from "./ui";

// NOTE: fonts, icons and tldraw's own translations ship in our build: the
// Content-Security-Policy allows no host but ours.
const assetUrls = getAssetUrlsByImport();

// The dice load after the canvas is usable (see warmUpDice).
const DiceStage = lazy(async () => {
  const { DiceStage: Stage } = await import("./dice-stage");
  return { default: Stage };
});

// NOTE: someone who asked for reduced motion never throws 3D dice, so their
// device does not fetch them either.
const loadDice = () => {
  void import("./dice-stage");
  if (!globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    void import("./dice-scene");
  }
};

// Fetches the dice code while the page is idle, so the first roll does not
// wait for it. Safari has no requestIdleCallback.
function warmUpDice(): () => void {
  if ("requestIdleCallback" in globalThis) {
    const handle = requestIdleCallback(loadDice, { timeout: 5000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(loadDice, 1500);
  return () => clearTimeout(handle);
}

// Below the top row, which holds tldraw's menus and the dice result toast,
// and below the toast when that drops under the menus.
function ConnectionBanner({ copy }: { copy: Copy }) {
  return (
    <p
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] [body:has([data-dice-toast=below])_&]:top-[calc(env(safe-area-inset-top)+6.25rem)] z-30 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full bg-ink px-4 py-2 text-center text-sm text-white shadow-lg"
      role="status"
    >
      {copy.connectionLost}
    </p>
  );
}

export function BoardCanvas({
  copy,
  exit,
  keeper,
  landing,
  language,
  licenseKey,
}: {
  copy: Copy;
  exit: Exit;
  keeper: PassKeeper;
  landing?: PublicLanding;
  language: string;
  licenseKey: string;
}) {
  const { board, person } = keeper.bootstrap;
  const color = colorFor(person.id);
  const rolls = useRolls(keeper);
  const files = useMemo(() => new BoardFiles(keeper), [keeper]);
  const { refusal, store } = useBoardStore({ color, files, keeper, rolls });
  const usable = store.status === "synced-remote";
  useEffect(() => (usable ? warmUpDice() : undefined), [usable]);
  // The cookie the board's pictures load with, before anyone opens a sheet
  // that shows them.
  useEffect(() => {
    if (usable) files.keepReadable();
  }, [files, usable]);
  // tldraw keeps trying a Worker it cannot reach behind a bare spinner; after
  // a while the person is told why nothing shows.
  const [stalled, setStalled] = useState(false);
  const connecting = store.status === "loading";
  useEffect(() => {
    setStalled(false);
    if (!connecting) return;
    const timer = setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connecting]);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [typing, setTyping] = useState(false);
  const [naming, setNaming] = useState<BoardUi["naming"]>(null);
  const [pool, setPool] = useState<number[]>([]);
  const highlight = useMemo(makeHighlight, []);
  const [search, setSearch] = useState<BoardSearch | null>(null);
  useEffect(() => {
    if (editor === null) return;
    const made = new BoardSearch(editor);
    setSearch(made);
    return () => made.dispose();
  }, [editor]);
  const [imageText, setImageText] = useState<ImageText | null>(null);
  useEffect(() => {
    if (editor === null || search === null || !usable) return;
    const made = new ImageText({ editor, engines: textEngines(), files, keeper, search });
    made.start();
    setImageText(made);
    return () => made.dispose();
  }, [editor, files, keeper, search, usable]);
  const ui = useMemo<BoardUi>(
    () => ({
      board,
      color,
      copy,
      editor,
      exit,
      files,
      highlight,
      imageText,
      locale: language,
      naming,
      open: (next, options) => {
        setPanel(next);
        setTyping(options?.typing ?? false);
        if (next !== "search") setNaming(null);
      },
      panel,
      person,
      pool,
      rolls,
      search,
      setNaming,
      setPool,
      typing,
    }),
    [
      board,
      color,
      copy,
      editor,
      exit,
      files,
      highlight,
      imageText,
      language,
      naming,
      panel,
      person,
      pool,
      rolls,
      search,
      typing,
    ],
  );
  const { open } = ui;
  useEffect(() => (editor === null ? undefined : searchFromKeyboard(open)), [editor, open]);
  const canvasComponents = useMemo(
    () =>
      landing === undefined
        ? components
        : {
            ...components,
            InFrontOfTheCanvas: () => (
              <>
                <PublicBoardIntro {...landing} />
                <FoundHighlight />
              </>
            ),
            MainMenu: () => <BoardMainMenu hideExit />,
          },
    [landing],
  );

  // NOTE: a full board waits and asks again (useBoardStore); the way out
  // stays in reach meanwhile.
  if (refusal === "full") return <Notice action={exit} text={copy.boardFull} />;
  // NOTE: a reset link or a deleted board ends the board (keeper.end).
  if (refusal !== null) return <Notice busy text={copy.loading} />;
  // NOTE: tldraw logs the reason of any sync error itself.
  if (store.status === "error") {
    return (
      <Notice
        action={{ label: copy.reload, run: () => location.reload() }}
        text={copy.bootstrapFailed}
      />
    );
  }
  const offline =
    (store.status === "synced-remote" && store.connectionStatus === "offline") ||
    (connecting && stalled);

  return (
    <BoardUiContext.Provider value={ui}>
      <div
        className="fixed inset-0 overflow-hidden"
        data-board-shell
        data-public-board={landing === undefined ? undefined : ""}
      >
        {/* NOTE: isolate keeps tldraw's own layers (its UI sits at z-index 300) under the board's sheets. */}
        <div className="absolute inset-0 isolate" data-board-editor>
          <Tldraw
            {...MEDIA_PROPS}
            assetUrls={assetUrls}
            colorScheme="system"
            components={canvasComponents}
            licenseKey={licenseKey === "" ? undefined : licenseKey}
            locale={language}
            onMount={(mounted) => {
              // NOTE: tldraw's own menus (the page menu's among them) take
              // their language from the person's preferences, not this prop.
              mounted.user.updateUserPreferences({ locale: language });
              setEditor(mounted);
            }}
            shapeUtils={SHAPE_UTILS}
            store={store}
          >
            <BoardFileHandlers />
            {landing === undefined && <PageKeeper board={board} copy={copy} />}
            <ThemeKeeper />
          </Tldraw>
        </div>
        {landing !== undefined && (
          <a className="absolute z-10" data-public-board-account href={exit.href}>
            {exit.label}
          </a>
        )}
        {offline && <ConnectionBanner copy={copy} />}
        {panel === "dice" && <DiceSheet />}
        {panel === "search" && <SearchSheet />}
        {panel === "people" && <PeopleSheet />}
        {rolls.arrived !== null && (
          <Suspense fallback={null}>
            <DiceStage copy={copy} onSettled={rolls.settle} roll={rolls.arrived} />
          </Suspense>
        )}
        <div aria-live="polite" className="sr-only">
          {rolls.arrived !== null && rollSentence(copy, rolls.arrived)}
        </div>
      </div>
    </BoardUiContext.Provider>
  );
}

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

const STALLED_AFTER_MS = 8000;

// Ctrl+F (⌘F on a Mac) searches the board instead of the page, whose own
// find cannot see into the canvas; pressed again, it goes back to the
// field. Taken before tldraw sees it.
function searchFromKeyboard(open: BoardUi["open"]): () => void {
  const find = (event: KeyboardEvent) => {
    const mod = /Mac|iPhone|iPad/u.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    event.stopPropagation();
    const field = document.getElementById(SEARCH_FIELD_ID);
    if (field instanceof HTMLInputElement) {
      field.focus();
      field.select();
    } else open("search", { typing: true });
  };
  document.addEventListener("keydown", find, { capture: true });
  return () => document.removeEventListener("keydown", find, { capture: true });
}

// A pasted YouTube or Figma link would become a frame onto that site, which
// the Content-Security-Policy refuses; it stays a plain link instead.
const SHAPE_UTILS = [EmbedShapeUtil.configure({ embedDefinitions: [] })];
