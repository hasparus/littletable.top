import { useEffect, useId, useRef, useState } from "react";

import type { FrontCopy } from "./front-copy";

import { fill } from "./copy";
import {
  type Account,
  FrontHeader,
  FrontMain,
  FrontPending,
  NAV_LINK,
  type Post,
  useApi,
  useFrontPage,
} from "./front-layout";
import {
  BOARD_DETAIL,
  BOARD_TITLE,
  BoardCollection,
  BoardThumbnail,
  EmptyList,
  LIST,
} from "./front-list";
import { assistantsShell } from "./front-skeleton";

export type AssistantAccess = "off" | "read" | "write";
type AssistantBoard = {
  access: AssistantAccess;
  hasThumbnail: boolean;
  id: string;
  role: "owner" | "manager";
  shareCode: string;
  title: string;
};
export type AssistantsPage = {
  account: Account;
  clients: { boards: AssistantBoard[]; id: string }[];
  csrf: string;
};

const SIGN_IN = "/auth/sign-in?return=/assistants";

const ROW =
  "relative grid min-h-15 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 py-2 @md:grid-cols-[auto_minmax(0,1fr)_auto] @3xl:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,22%)_auto] @3xl:gap-x-4";
const CHOICE =
  "col-start-2 row-start-3 mt-2 justify-self-start @md:col-start-3 @md:row-span-2 @md:row-start-1 @md:mt-0 @md:justify-self-end @3xl:col-start-4 @3xl:row-span-1";
const LEVEL =
  "relative flex min-h-11 min-w-14 cursor-pointer items-center justify-center rounded-[0.625rem] px-3 text-sm font-medium text-foreground-secondary select-none hover:text-foreground has-checked:bg-bg-secondary has-checked:shadow-board-control has-checked:ring-1 has-checked:ring-border has-focus-visible:outline-2 has-focus-visible:outline-border-focus";

type Saving = "idle" | "saving" | "saved" | "failed";

function useSavedAccess(post: Post, client: string, board: AssistantBoard) {
  const [chosen, setChosen] = useState(board.access);
  const [saving, setSaving] = useState<Saving>("idle");
  const saved = useRef(board.access);
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);
  const send = async (access: AssistantAccess, ticket: number) => {
    const response = await post("/api/assistants", { access, board: board.id, client }).catch(
      () => null,
    );
    const ok = response?.ok === true;
    if (ok) saved.current = access;
    if (ticket !== latest.current) return;
    if (!ok) setChosen(saved.current);
    setSaving(ok ? "saved" : "failed");
  };
  const choose = (access: AssistantAccess) => {
    const ticket = ++latest.current;
    setChosen(access);
    setSaving("saving");
    queue.current = queue.current.then(() => send(access, ticket));
  };
  return { choose, chosen, saving };
}

function AccessRow({
  board,
  client,
  copy,
  post,
}: {
  board: AssistantBoard;
  client: string;
  copy: FrontCopy;
  post: Post;
}) {
  const name = useId();
  const { choose, chosen, saving } = useSavedAccess(post, client, board);
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
      <div className={ROW}>
        <BoardThumbnail board={board} />
        <span className={`${BOARD_TITLE} wrap-anywhere`}>{board.title}</span>
        <span className={BOARD_DETAIL}>
          {board.role === "owner" ? copy.ownBoard : copy.managedBoard}
          {progress !== "" && <span aria-hidden="true"> · </span>}
          <span role="status">{progress}</span>
        </span>
        <div
          aria-busy={saving === "saving"}
          aria-label={fill(copy.accessFor, { title: board.title })}
          className={`${CHOICE} inline-flex rounded-xl border border-border bg-bg-tertiary p-0.5`}
          role="radiogroup"
        >
          {levels.map(([level, label]) => (
            <label
              className={`${LEVEL} ${level === "off" ? "has-checked:text-foreground" : "has-checked:text-primary-strong"}`}
              key={level}
            >
              <input
                checked={chosen === level}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-[inherit] opacity-0"
                name={name}
                onChange={() => choose(level)}
                type="radio"
                value={level}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
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
        <div className="mt-6 grid gap-8">
          {page.clients.length === 0 ? (
            <EmptyList>{fill(copy.noClients, { name })}</EmptyList>
          ) : (
            page.clients.map((client, index) => (
              <BoardCollection
                collapsible={false}
                key={client.id}
                label={fill(copy.client, { number: index + 1 })}
              >
                <p className="-mt-1 mb-2 text-sm wrap-anywhere text-foreground-muted">
                  {client.id}
                </p>
                {client.boards.length === 0 ? (
                  <EmptyList>{copy.noEligibleBoards}</EmptyList>
                ) : (
                  <ul className={LIST}>
                    {client.boards.map((board) => (
                      <AccessRow
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
  initialPage?: AssistantsPage;
  name: string;
}) {
  const [page] = useFrontPage<AssistantsPage>("/api/assistants", initialPage);
  useEffect(() => {
    if (page === "signed-out") location.assign(SIGN_IN);
  }, [page]);
  if (page === null || page === "failed" || page === "signed-out") {
    return <FrontPending copy={copy} failed={page === "failed"} shell={assistantsShell} />;
  }
  return <SignedIn copy={copy} name={name} page={page} />;
}
