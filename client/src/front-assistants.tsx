import { useId, useRef, useState, useSyncExternalStore } from "react";

import type { FrontCopy } from "./front-copy";

import { fill } from "./copy";
import {
  type Account,
  FrontFailed,
  FrontHeader,
  FrontMain,
  NAV_LINK,
  type Post,
  useApi,
} from "./front-layout";
import { BoardCollection, BoardRow, EmptyList, LIST } from "./front-list";
import {
  ASSISTANTS_SIGN_IN,
  type AssistantAccess,
  type AssistantBoard,
  type Loaded,
} from "./front-page";
import { latestWins } from "./latest-wins";

export type AssistantsPage = {
  account: Account;
  clients: { boards: AssistantBoard[]; id: string }[];
  csrf: string;
};

const LEVEL =
  "relative flex min-h-11 min-w-14 items-center justify-center rounded-[0.625rem] px-3 text-sm font-medium text-foreground-secondary select-none not-has-disabled:cursor-pointer not-has-disabled:hover:text-foreground has-checked:bg-bg-secondary has-checked:shadow-board-control has-checked:ring-1 has-checked:ring-border has-focus-visible:outline-2 has-focus-visible:outline-border-focus";
const KEYBOARD_PAUSE_MS = 500;
const SAVED_SHOWN_MS = 3000;

type Saving = "idle" | "saving" | "saved" | "failed";

const subscribeToNothing = () => () => null;
const useHydrated = () =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

function useSavedAccess({
  announce,
  board,
  client,
  copy,
  post,
}: {
  announce: (message: string) => void;
  board: AssistantBoard;
  client: string;
  copy: FrontCopy;
  post: Post;
}) {
  const [chosen, setChosen] = useState(board.access);
  const [saving, setSaving] = useState<Saving>("idle");
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = (state: Saving) => {
    setSaving(state);
    if (state === "saving") announce(copy.saving);
    else if (state === "saved") announce(copy.saved);
  };
  const save = async (access: AssistantAccess) => {
    const response = await post("/api/assistants", { access, board: board.id, client }).catch(
      () => null,
    );
    if (response?.status === 401) location.assign(ASSISTANTS_SIGN_IN);
    return response?.ok === true;
  };
  const queue = useRef<ReturnType<typeof latestWins<AssistantAccess>> | null>(null);
  const commit = (access: AssistantAccess) => {
    if (queue.current === null) queue.current = latestWins(board.access, save);
    void queue.current.choose(access)?.then(({ ok, saved }) => {
      if (pause.current !== undefined) return;
      setChosen(saved);
      show(ok ? "saved" : "failed");
      if (ok) hide.current = setTimeout(() => setSaving("idle"), SAVED_SHOWN_MS);
    });
  };
  const choose = (access: AssistantAccess, byKeyboard: boolean) => {
    clearTimeout(pause.current);
    clearTimeout(hide.current);
    pause.current = undefined;
    setChosen(access);
    show("saving");
    if (!byKeyboard) {
      commit(access);
      return;
    }
    pause.current = setTimeout(() => {
      pause.current = undefined;
      commit(access);
    }, KEYBOARD_PAUSE_MS);
  };
  return { choose, chosen, saving };
}

function AccessRow({
  announce,
  board,
  client,
  copy,
  post,
}: {
  announce: (message: string) => void;
  board: AssistantBoard;
  client: string;
  copy: FrontCopy;
  post: Post;
}) {
  const name = useId();
  const hydrated = useHydrated();
  const byKeyboard = useRef(false);
  const { choose, chosen, saving } = useSavedAccess({ announce, board, client, copy, post });
  const levels = [
    ["off", copy.accessOff],
    ["read", copy.accessRead],
    ["write", copy.accessEdit],
  ] as const;
  let progress = "";
  if (saving === "saving") progress = copy.saving;
  else if (saving === "saved") progress = copy.saved;
  return (
    <li>
      <BoardRow
        action={
          <div
            aria-busy={saving === "saving"}
            aria-label={fill(copy.accessFor, { title: board.title })}
            className="inline-flex rounded-xl border border-border bg-bg-tertiary p-0.5"
            role="radiogroup"
          >
            {levels.map(([level, label]) => (
              <label
                className={`${LEVEL} ${level === "off" ? "has-checked:text-foreground" : "has-checked:text-primary-strong"}`}
                key={level}
              >
                <input
                  checked={chosen === level}
                  className="absolute inset-0 m-0 cursor-[inherit] appearance-none rounded-[inherit] opacity-0"
                  disabled={!hydrated}
                  name={name}
                  onChange={() => choose(level, byKeyboard.current)}
                  onKeyDown={(event) => {
                    byKeyboard.current = event.key.startsWith("Arrow");
                  }}
                  onPointerDown={() => {
                    byKeyboard.current = false;
                  }}
                  type="radio"
                  value={level}
                />
                {label}
              </label>
            ))}
          </div>
        }
        actionPlacement="below"
        board={{ id: board.id, thumbnail: board.hasThumbnail }}
        detail={
          <>
            {board.role === "owner" ? copy.ownBoard : copy.managedBoard}
            {progress !== "" && ` · ${progress}`}
          </>
        }
        title={board.title}
      />
      {saving === "failed" && (
        <p className="pb-2 text-sm text-danger-text" role="alert">
          {copy.actionFailed}
        </p>
      )}
    </li>
  );
}

function SignedIn({ copy, name, page }: { copy: FrontCopy; name: string; page: AssistantsPage }) {
  const post = useApi(page.csrf);
  const [announcement, setAnnouncement] = useState("");
  return (
    <>
      <FrontHeader
        account={page.account}
        copy={copy}
        name={name}
        nav={
          <a className={NAV_LINK} href="/boards">
            {copy.yourBoards}
          </a>
        }
        post={post}
      />
      <FrontMain intro={copy.assistantsHelp} title={copy.assistants}>
        <p className="sr-only" role="status">
          {announcement}
        </p>
        <div className="mt-6 grid gap-8">
          {page.clients.length === 0 ? (
            <EmptyList>{fill(copy.noClients, { name })}</EmptyList>
          ) : (
            page.clients.map((client, index) => (
              <BoardCollection
                collapsible={false}
                description={client.id}
                key={client.id}
                label={fill(copy.client, { number: index + 1 })}
              >
                {client.boards.length === 0 ? (
                  <EmptyList>{copy.noEligibleBoards}</EmptyList>
                ) : (
                  <ul className={LIST}>
                    {client.boards.map((board) => (
                      <AccessRow
                        announce={setAnnouncement}
                        board={board}
                        client={client.id}
                        copy={copy}
                        key={board.id}
                        post={post}
                      />
                    ))}
                  </ul>
                )}
              </BoardCollection>
            ))
          )}
        </div>
      </FrontMain>
    </>
  );
}

export function Assistants({
  copy,
  initialPage,
  name,
}: {
  copy: FrontCopy;
  initialPage: Loaded<AssistantsPage>;
  name: string;
}) {
  return initialPage === "failed" || initialPage === "signed-out" ? (
    <FrontFailed copy={copy} />
  ) : (
    <SignedIn copy={copy} name={name} page={initialPage} />
  );
}
