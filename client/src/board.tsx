import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Editor, useValue } from "tldraw";

import type { Language } from "../settings";
import type { PublicLanding } from "./public-landing";

import { BoardLoading } from "./board-loading";
import { BoardNameProvider } from "./board-name";
import { BoardShare } from "./board-share";
import { useBoardViewport } from "./board-viewport";
import {
  type Answer,
  type Bootstrap,
  type Door,
  type Ending,
  knock,
  PassKeeper,
} from "./bootstrap";
import { BoardCanvas } from "./canvas";
import { type Copy, fill } from "./copy";
import { FeedbackProvider } from "./feedback";
import { Icon } from "./icons";
import { LandingPlaceholder } from "./landing-placeholder";
import { NameForm } from "./name-form";
import { Notice } from "./notice";
import { alignLayers, carryTool, openOverlay } from "./secret-backdrop";

type Stage =
  | { ending: Ending; exit: Exit; kind: "ended" }
  | { error: string | null; kind: "name" }
  | { exit: Exit; keeper: PassKeeper; kind: "ready" }
  | { kind: "failed"; text: string }
  | { kind: "loading" };

export type Exit = { href: string; label: string };

type Layer = "shared" | "overlay" | "manage" | "full" | "unavailable";

type Mount = {
  copy: Copy;
  door: Door;
  feedback: boolean;
  fallbackExit: Exit;
  first: Promise<Answer>;
  landing?: PublicLanding;
  language: Language;
  licenseKey: string;
};

function useSharingWidth(row: HTMLElement | null) {
  useLayoutEffect(() => {
    const layout = row?.parentElement;
    if (row === null || !layout) return;
    const measure = new ResizeObserver(() =>
      layout.style.setProperty("--board-sharing-width", `${row.offsetWidth}px`),
    );
    measure.observe(row);
    return () => measure.disconnect();
  }, [row]);
}

function ReadyBoard({
  copy,
  exit,
  keeper,
  landing,
  language,
  licenseKey,
}: Pick<Mount, "copy" | "landing" | "language" | "licenseKey"> & {
  exit: Exit;
  keeper: PassKeeper;
}) {
  useBoardViewport();
  const [shared, setShared] = useState<Editor | null>(null);
  const [secret, setSecret] = useState<PassKeeper>();
  const [privateEditor, setPrivateEditor] = useState<Editor | null>(null);
  const [layer, setLayer] = useState<Layer>("shared");
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  useSharingWidth(controls);
  const editingSecret = layer === "overlay" || layer === "manage";
  const visibleSharedEditor = useValue(
    "visible shared page",
    () => {
      if (layer === "manage") return null;
      if (
        layer === "overlay" &&
        privateEditor &&
        shared?.getCurrentPageId() !== privateEditor.getCurrentPageId()
      )
        return null;
      return shared;
    },
    [layer, privateEditor, shared],
  );
  const canEnterSecret = layer !== "unavailable" && keeper.bootstrap.secretPass !== undefined;
  const closeSecret = useCallback(() => {
    setSecret(undefined);
    setLayer("unavailable");
  }, []);
  useLayoutEffect(() => {
    if (layer === "overlay" && shared && privateEditor) return alignLayers(shared, privateEditor);
  }, [layer, privateEditor, shared]);

  function enterOverlay(editor: Editor) {
    if (shared) setLayer(openOverlay(shared, editor) ? "overlay" : "full");
  }

  return (
    <div data-board-layout>
      <BoardCanvas
        active={!editingSecret}
        backdrop={layer === "overlay"}
        controls={controls}
        waiting={editingSecret && privateEditor === null}
        copy={copy}
        exit={exit}
        keeper={keeper}
        landing={landing}
        language={language}
        licenseKey={licenseKey}
        onEditor={landing === undefined ? setShared : undefined}
      />
      {secret !== undefined && (
        <BoardCanvas
          active={editingSecret}
          overlay={layer === "overlay"}
          copy={copy}
          exit={exit}
          keeper={secret}
          language={language}
          licenseKey={licenseKey}
          onEditor={(editor) => {
            if (editor && layer === "overlay") enterOverlay(editor);
            setPrivateEditor(editor);
          }}
        />
      )}
      {landing === undefined && (
        <div data-board-sharing ref={setControls}>
          <BoardShare copy={copy} editor={visibleSharedEditor} keeper={keeper} />
          {canEnterSecret && (
            <button
              aria-busy={editingSecret && privateEditor === null}
              aria-label={copy.secretLayer}
              aria-pressed={editingSecret && privateEditor !== null}
              data-secret-layer-toggle
              disabled={shared === null}
              onClick={() => {
                if (!shared) return;
                if (editingSecret) {
                  if (privateEditor) carryTool(privateEditor, shared);
                  setLayer("shared");
                } else if (privateEditor) {
                  enterOverlay(privateEditor);
                } else {
                  if (!secret) setSecret(keeper.forSecret(closeSecret));
                  setLayer("overlay");
                }
              }}
              title={copy.secretLayer}
              type="button"
            >
              <Icon name="Incognito" />
            </button>
          )}
        </div>
      )}
      {layer === "full" && (
        <div className="fixed top-16 left-1/2 z-60 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl bg-bg-secondary px-4 py-2 text-sm shadow-toast">
          <p role="status">{copy.secretLayerFull}</p>
          <button
            className="underline"
            onClick={() => {
              if (shared && privateEditor) carryTool(shared, privateEditor);
              setLayer("manage");
            }}
            type="button"
          >
            {copy.manageSecretPages}
          </button>
        </div>
      )}
    </div>
  );
}

function exitOf(copy: Copy, { boardsUrl, home }: Bootstrap): Exit {
  return boardsUrl === null
    ? { href: home.url, label: fill(copy.backTo, { home: home.name }) }
    : { href: boardsUrl, label: copy.myBoards };
}

function bootstrapError(copy: Copy, kind: Answer["kind"]) {
  switch (kind) {
    case "daily-server-limit":
      return copy.bootstrapDailyLimit;
    case "failed":
      return copy.bootstrapFailed;
    case "throttled":
      return copy.tooManyTries;
    case "unavailable":
      return copy.bootstrapUnavailable;
    default:
      return null;
  }
}

function Board({ copy, door, fallbackExit, first, landing, language, licenseKey }: Mount) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  const settle = useCallback(
    (answer: Answer) => {
      if (answer.kind === "ready") {
        const exit =
          landing !== undefined && answer.bootstrap.boardsUrl === null
            ? { href: "/auth/sign-in?return=/boards", label: landing.copy.signIn }
            : exitOf(copy, answer.bootstrap);
        document.title = answer.bootstrap.title;
        // WARNING: A late renewal response must not reopen an ended board.
        const keeper = new PassKeeper(door, answer.bootstrap, (ending) =>
          setStage((current) =>
            current.kind === "ended" ? current : { ending, exit, kind: "ended" },
          ),
        );
        setStage({ exit, keeper, kind: "ready" });
      } else if (answer.kind === "name-required" || answer.kind === "name-invalid") {
        const error = answer.kind === "name-invalid" ? copy.nameInvalid : null;
        setStage({ error, kind: "name" });
      } else if (answer.kind === "gone" || answer.kind === "link-reset") {
        setStage({ ending: answer.kind, exit: fallbackExit, kind: "ended" });
      } else {
        const text = bootstrapError(copy, answer.kind) ?? copy.bootstrapFailed;
        setStage({ kind: "failed", text });
      }
    },
    [copy, door, fallbackExit, landing],
  );

  useEffect(() => {
    void first.then((answer) => settle(answer));
  }, [first, settle]);

  switch (stage.kind) {
    // WARNING: Reloading a deleted board or a reset guest link cannot restore access.
    case "ended":
      return (
        <Notice
          action={stage.exit}
          text={stage.ending === "gone" ? copy.boardGone : copy.linkReset}
        />
      );
    case "failed":
      return (
        <Notice
          action={{
            label: copy.retry,
            run: () => {
              setStage({ kind: "loading" });
              void knock(door).then(settle);
            },
          }}
          text={stage.text}
        />
      );
    case "loading":
      return (
        <>
          <BoardLoading text={copy.loading} />
          {landing && <LandingPlaceholder copy={landing.copy} />}
        </>
      );
    case "name":
      return (
        <NameForm
          copy={copy}
          error={stage.error}
          onSubmit={async (name) => {
            const answer = await knock(door, name);
            const error = bootstrapError(copy, answer.kind);
            if (error === null) settle(answer);
            else setStage({ ...stage, error });
          }}
        />
      );
    case "ready":
      return (
        <BoardNameProvider keeper={stage.keeper}>
          <ReadyBoard
            copy={copy}
            exit={stage.exit}
            keeper={stage.keeper}
            landing={landing}
            language={language}
            licenseKey={licenseKey}
          />
        </BoardNameProvider>
      );
  }
}

export function mountBoard(element: HTMLElement, mount: Mount): void {
  createRoot(element).render(
    <FeedbackProvider enabled={mount.feedback} language={mount.language}>
      <Board {...mount} />
    </FeedbackProvider>,
  );
}
