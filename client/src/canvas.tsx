import type { Editor } from "tldraw";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import "./board.css";

import type { Exit } from "./board";
import type { PassKeeper } from "./bootstrap";
import type { Copy } from "./copy";
import type { PublicLanding } from "./public-landing";
import type { SharedView } from "./secret-backdrop";

import { secretLayerOf } from "../../src/secret-layer";
import { BoardFiles } from "./assets";
import { BoardEditors } from "./board-editors";
import { BoardStatus } from "./board-files";
import { keepThumbnail } from "./board-thumbnail";
import { ChatSheet, useChat } from "./chat";
import { colorFor } from "./colors";
import { DiceSheet } from "./dice";
import { rollSentence } from "./dice-labels";
import { makeHighlight } from "./highlight";
import { Icon } from "./icons";
import { ImageText } from "./image-text";
import { LandingPlaceholder } from "./landing-placeholder";
import { Notice } from "./notice";
import { PeopleSheet } from "./people";
import { useRolls } from "./rolls";
import { BoardSearch } from "./search-board";
import { SEARCH_FIELD_ID, SearchSheet } from "./search-sheet";
import { useBoardStore } from "./sync";
import { textEngines } from "./text-support";
import { type BoardUi, BoardUiContext, type Panel, PANEL_ID } from "./ui";

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

// Trackpad pinches can arrive as modified wheel events or Safari gesture
// events. Cancel browser zoom without intercepting the canvas handlers.
const cancelPinchZoom = (event: Event) => event.preventDefault();
const cancelWheelZoom = (event: WheelEvent) => {
  if (event.ctrlKey || event.metaKey) cancelPinchZoom(event);
};

function keepBoardZoom(shell: HTMLDivElement | null) {
  if (shell === null) return;
  shell.addEventListener("gesturestart", cancelPinchZoom);
  shell.addEventListener("gesturechange", cancelPinchZoom);
  shell.addEventListener("wheel", cancelWheelZoom, { passive: false });
  return () => {
    shell.removeEventListener("gesturestart", cancelPinchZoom);
    shell.removeEventListener("gesturechange", cancelPinchZoom);
    shell.removeEventListener("wheel", cancelWheelZoom);
  };
}

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

export function BoardCanvas({
  active,
  backdrop,
  copy,
  exit,
  keeper,
  landing,
  language,
  licenseKey,
  onEditor,
  onLayerFull,
}: {
  active: boolean;
  backdrop?: SharedView;
  copy: Copy;
  exit: Exit;
  keeper: PassKeeper;
  landing?: PublicLanding;
  language: string;
  licenseKey: string;
  onEditor?: (editor: Editor | null) => void;
  onLayerFull?: () => void;
}) {
  const { person } = keeper.bootstrap;
  const board = keeper.secret ? secretLayerOf(keeper.bootstrap.board) : keeper.bootstrap.board;
  const color = colorFor(person.id);
  const rolls = useRolls(keeper);
  const chat = useChat(keeper, landing !== undefined);
  const files = useMemo(() => new BoardFiles(keeper, landing !== undefined), [keeper, landing]);
  const { refusal, store } = useBoardStore({
    active,
    color,
    files,
    keeper,
    receiveChat: chat.receive,
    rolls,
  });
  const usable = active && store.status === "synced-remote";
  const online = usable && store.connectionStatus === "online";
  useEffect(() => (usable ? warmUpDice() : undefined), [usable]);
  // The cookie the board's pictures load with, before anyone opens a sheet
  // that shows them.
  useEffect(() => {
    if (usable) files.keepReadable();
  }, [files, usable]);
  // tldraw keeps trying a Worker it cannot reach behind a bare spinner; after
  // a while the person is told why nothing shows.
  const [stalled, setStalled] = useState(false);
  const connecting = active && store.status === "loading";
  useEffect(() => {
    setStalled(false);
    if (!connecting) return;
    const timer = setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connecting]);

  const [editor, setEditor] = useState<Editor | null>(null);
  // Pending edits and cooldown belong to the lifetime of the shared editor.
  const thumbnail = useRef<ReturnType<typeof keepThumbnail> | null>(null);
  useEffect(() => {
    const grant = keeper.bootstrap.thumbnail;
    if (editor === null || grant === undefined || keeper.secret || landing !== undefined) return;
    const capture = keepThumbnail(editor, board, grant);
    thumbnail.current = capture;
    return () => {
      capture.dispose();
      thumbnail.current = null;
    };
  }, [board, editor, keeper, landing]);
  useEffect(() => {
    thumbnail.current?.setAvailable(online);
  }, [board, editor, keeper, landing, online]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [readChat, setReadChat] = useState(0);
  const { refresh } = chat;
  const openOfflineChat = !online && panel === "chat";
  useEffect(() => {
    if (!online && !openOfflineChat) return;
    const pending = new AbortController();
    void refresh(pending.signal);
    return () => pending.abort();
  }, [online, openOfflineChat, refresh]);
  const [typing, setTyping] = useState(false);
  const [naming, setNaming] = useState<BoardUi["naming"]>(null);
  const [rollDraft, setRollDraft] = useState<BoardUi["rollDraft"]>({ expression: "", pool: [] });
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
      close: (name) => {
        if (name === "chat") setReadChat(chat.latestIncoming);
        setPanel((current) => (current === name ? null : current));
      },
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
        if (panel === "chat" || next === "chat") setReadChat(chat.latestIncoming);
        setPanel(next);
        setTyping(options?.typing ?? false);
        if (next !== "search") setNaming(null);
      },
      panel,
      person,
      rollDraft,
      rolls,
      search,
      setNaming,
      setRollDraft,
      typing,
    }),
    [
      board,
      chat.latestIncoming,
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
      rollDraft,
      rolls,
      search,
      typing,
    ],
  );
  const { open } = ui;
  useEffect(
    () => (active && editor !== null ? searchFromKeyboard(open) : undefined),
    [active, editor, open],
  );
  // NOTE: a full board waits and asks again (useBoardStore); the way out
  // stays in reach meanwhile.
  if (refusal === "full") return active ? <Notice action={exit} text={copy.boardFull} /> : null;
  // NOTE: a reset link or a deleted board ends the board (keeper.end).
  if (refusal !== null) return active ? <Notice busy text={copy.loading} /> : null;
  // NOTE: tldraw logs the reason of any sync error itself.
  if (store.status === "error") {
    return active ? (
      <Notice
        action={{ label: copy.reload, run: () => location.reload() }}
        text={copy.bootstrapFailed}
      />
    ) : null;
  }
  const offline =
    (store.status === "synced-remote" && store.connectionStatus === "offline") ||
    (connecting && stalled);

  return (
    <BoardUiContext.Provider value={ui}>
      <div
        className="fixed inset-0 overflow-hidden"
        data-board-shell
        hidden={!active}
        ref={keepBoardZoom}
      >
        <BoardEditors
          active={active}
          backdrop={backdrop}
          landing={landing}
          licenseKey={licenseKey}
          onEditor={(mounted) => {
            setEditor(mounted);
            onEditor?.(mounted);
          }}
          onLayerFull={onLayerFull}
          secret={keeper.secret}
          store={store}
        />
        {landing && editor === null && <LandingPlaceholder copy={landing.copy} />}
        {landing !== undefined && (
          <div className="absolute z-10 flex gap-1" data-public-board-controls>
            <button
              aria-controls={panel === "chat" ? PANEL_ID.chat : undefined}
              aria-expanded={panel === "chat"}
              aria-label={copy.chat}
              className="relative place-items-center"
              data-public-board-chat
              onClick={() => open(panel === "chat" ? null : "chat")}
              title={copy.chat}
              type="button"
            >
              <Icon name="Chat" />
              {panel !== "chat" && chat.latestIncoming > readChat && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary"
                />
              )}
            </button>
            <a data-public-board-account href={exit.href}>
              {exit.label}
            </a>
          </div>
        )}
        {active && <BoardStatus offline={offline} />}
        {active && landing !== undefined && <ChatSheet chat={chat} shown={panel === "chat"} />}
        {active && panel === "dice" && <DiceSheet />}
        {active && panel === "search" && <SearchSheet />}
        {active && panel === "people" && <PeopleSheet />}
        {active && rolls.arrived !== null && (
          <Suspense fallback={null}>
            <DiceStage
              copy={copy}
              onRoll={rolls.roll}
              onSettled={rolls.settle}
              roll={rolls.arrived}
            />
          </Suspense>
        )}
        <div aria-live="polite" className="sr-only">
          {rolls.arrived !== null && rollSentence(copy, rolls.arrived)}
        </div>
      </div>
    </BoardUiContext.Provider>
  );
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
