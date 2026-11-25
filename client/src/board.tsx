import type { Editor } from "tldraw";

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { PublicLanding } from "./public-landing";

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
import { NameForm } from "./name-form";
import { Notice } from "./notice";
import { captureSharedView, type SharedView } from "./secret-backdrop";

type Stage =
  | { ending: Ending; exit: Exit; kind: "ended" }
  | { error: string | null; kind: "name" }
  | { exit: Exit; keeper: PassKeeper; kind: "ready" }
  | { kind: "failed"; text: string }
  | { kind: "loading" };

export type Exit = { href: string; label: string };

type Layer =
  | { kind: "full" | "manage" | "shared" | "unavailable" }
  | { kind: "overlay"; view: SharedView };

type Mount = {
  copy: Copy;
  door: Door;
  // Where a person goes before the host has said whose board this is.
  fallbackExit: Exit;
  first: Promise<Answer>;
  landing?: PublicLanding;
  language: string;
  licenseKey: string;
};

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
  const [shared, setShared] = useState<Editor | null>(null);
  const [secret, setSecret] = useState<PassKeeper>();
  const [layer, setLayer] = useState<Layer>({ kind: "shared" });
  const view = layer.kind === "overlay" ? layer.view : undefined;
  const editingSecret = view !== undefined || layer.kind === "manage";
  const canEnterSecret = layer.kind !== "unavailable" && keeper.bootstrap.secretPass !== undefined;
  const closeSecret = useCallback(() => {
    setSecret(undefined);
    setLayer({ kind: "unavailable" });
  }, []);
  const refuseSecretPage = useCallback(() => setLayer({ kind: "full" }), []);
  useEffect(() => () => view?.store.dispose(), [view]);
  return (
    <div data-board-layout>
      <BoardCanvas
        active={!editingSecret}
        copy={copy}
        exit={exit}
        keeper={keeper}
        landing={landing}
        language={language}
        licenseKey={licenseKey}
        onEditor={canEnterSecret ? setShared : undefined}
      />
      {/* NOTE: the room's connection keeps sending pending edits when its editor is out of view. */}
      {secret !== undefined && (
        <BoardCanvas
          active={editingSecret}
          backdrop={view}
          copy={copy}
          exit={exit}
          keeper={secret}
          language={language}
          licenseKey={licenseKey}
          onLayerFull={refuseSecretPage}
        />
      )}
      {canEnterSecret && (
        <button
          aria-pressed={editingSecret}
          data-secret-layer-toggle
          disabled={!editingSecret && shared === null}
          onClick={() => {
            if (editingSecret) {
              setLayer({ kind: "shared" });
            } else if (shared !== null) {
              setLayer({ kind: "overlay", view: captureSharedView(shared) });
              if (secret === undefined) setSecret(keeper.forSecret(closeSecret));
            }
          }}
          type="button"
        >
          {copy.secretLayer}
        </button>
      )}
      {layer.kind === "full" && (
        <div className="fixed top-16 left-1/2 z-60 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl bg-bg-secondary px-4 py-2 text-sm shadow-toast">
          <p role="status">{copy.secretLayerFull}</p>
          <button className="underline" onClick={() => setLayer({ kind: "manage" })} type="button">
            {copy.manageSecretPages}
          </button>
        </div>
      )}
    </div>
  );
}

// Where a person goes from the board: their boards for a member, the place
// the board belongs to for a guest.
function exitOf(copy: Copy, { boardsUrl, home }: Bootstrap): Exit {
  return boardsUrl === null
    ? { href: home.url, label: fill(copy.backTo, { home: home.name }) }
    : { href: boardsUrl, label: copy.myBoards };
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
        // NOTE: an ending only ever moves forward; a late renewal answer
        // must not bring a reset board back.
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
        const text = answer.kind === "throttled" ? copy.tooManyTries : copy.bootstrapFailed;
        setStage({ kind: "failed", text });
      }
    },
    [copy, door, fallbackExit, landing],
  );

  useEffect(() => {
    void first.then((answer) => settle(answer));
  }, [first, settle]);

  switch (stage.kind) {
    // NOTE: a reload cannot help either ending: the old link opens nothing.
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
      return <Notice busy text={copy.loading} />;
    case "name":
      return (
        <NameForm
          copy={copy}
          error={stage.error}
          onSubmit={async (name) => {
            const answer = await knock(door, name);
            if (answer.kind === "failed") setStage({ ...stage, error: copy.bootstrapFailed });
            else if (answer.kind === "throttled") {
              setStage({ ...stage, error: copy.tooManyTries });
            } else settle(answer);
          }}
        />
      );
    case "ready":
      return (
        <ReadyBoard
          copy={copy}
          exit={stage.exit}
          keeper={stage.keeper}
          landing={landing}
          language={language}
          licenseKey={licenseKey}
        />
      );
  }
}

export function mountBoard(element: HTMLElement, mount: Mount): void {
  createRoot(element).render(<Board {...mount} />);
}
