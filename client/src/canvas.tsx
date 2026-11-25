import type { Editor } from "tldraw";

import { unlock } from "cuelume";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import "./board.css";

import type { Exit } from "./board";
import type { PassKeeper } from "./bootstrap";
import type { Copy } from "./copy";
import type { PublicLanding } from "./public-landing";

import { secretLayerOf } from "../../src/secret-layer";
import { BoardFiles } from "./assets";
import { BoardEditors } from "./board-editors";
import { BoardStatus } from "./board-files";
import { BoardLoading } from "./board-loading";
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

const DiceStage = lazy(async () => {
  const { DiceStage: Stage } = await import("./dice-stage");
  return { default: Stage };
});

// WARNING: Avoid fetching the 3D dice scene when reduced motion is enabled.
const loadDice = () => {
  void import("./dice-stage");
  if (!globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    void import("./dice-scene");
  }
};

// WARNING: Cancel browser pinch zoom for both modified wheel events and Safari gesture events without blocking the editor handlers.
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

// WARNING: Keep the timer fallback for Safari versions without requestIdleCallback.
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
  backdrop = false,
  overlay = false,
  waiting = false,
  copy,
  exit,
  keeper,
  landing,
  language,
  licenseKey,
  onEditor,
}: {
  active: boolean;
  backdrop?: boolean;
  overlay?: boolean;
  waiting?: boolean;
  copy: Copy;
  exit: Exit;
  keeper: PassKeeper;
  landing?: PublicLanding;
  language: string;
  licenseKey: string;
  onEditor?: (editor: Editor | null) => void;
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
  // WARNING: Fetch the files cookie before any panel needs to display authenticated images.
  useEffect(() => {
    if (usable) files.keepReadable();
  }, [files, usable]);
  const connecting = active && store.status === "loading";
  const [connection, setConnection] = useState({ connecting, stalled: false });
  if (connection.connecting !== connecting) {
    setConnection({ connecting, stalled: false });
  }
  useEffect(() => {
    if (!connecting) return;
    const timer = setTimeout(() => setConnection({ connecting, stalled: true }), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connecting]);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorLayer, setEditorLayer] = useState<HTMLDivElement | null>(null);
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
  const highlight = useMemo(() => makeHighlight(), []);
  const [search, setSearch] = useState<BoardSearch | null>(null);
  useEffect(() => {
    if (editor === null) return;
    const made = new BoardSearch(editor);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish the editor-bound index after its subscriptions are installed.
    setSearch(made);
    return () => made.dispose();
  }, [editor]);
  const [imageText, setImageText] = useState<ImageText | null>(null);
  useEffect(() => {
    if (editor === null || search === null || !usable) return;
    const made = new ImageText({ editor, engines: textEngines(), files, keeper, search });
    made.start();
    // oxlint-disable-next-line react/set-state-in-effect -- Publish the OCR resource only after it starts listening to the active editor.
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
        if (next === "chat" && navigator.maxTouchPoints > 0) void unlock();
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
  if (refusal === "full") return active ? <Notice action={exit} text={copy.boardFull} /> : null;
  if (refusal !== null) return active ? <BoardLoading text={copy.loading} /> : null;
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
    (connecting && connection.stalled);

  return (
    <BoardUiContext.Provider value={ui}>
      <div
        className="fixed inset-0 overflow-hidden"
        data-board-shell
        hidden={!active && !backdrop}
        style={keeper.secret && editor === null ? { visibility: "hidden" } : undefined}
        ref={keepBoardZoom}
      >
        <BoardEditors
          active={active}
          editorLayerRef={setEditorLayer}
          overlay={overlay}
          showUi={active || waiting}
          landing={landing}
          licenseKey={licenseKey}
          onEditor={(mounted) => {
            setEditor(mounted);
            onEditor?.(mounted);
          }}
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
            <a
              aria-label="Source code on GitHub"
              data-public-board-github
              href="https://github.com/hasparus/littletable.top"
              title="Source code on GitHub"
            >
              <Icon name="GitHub" />
            </a>
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
        {active && editorLayer !== null && rolls.arrived !== null && (
          <Suspense fallback={null}>
            <DiceStage
              copy={copy}
              editorLayer={editorLayer}
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

// WARNING: Listen during capture so tldraw and the browser do not intercept board search first.
function searchFromKeyboard(open: BoardUi["open"]): () => void {
  const find = (event: KeyboardEvent) => {
    const mod = /Mac|iPhone|iPad/u.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
    if (document.querySelector("dialog:modal")) return;
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
