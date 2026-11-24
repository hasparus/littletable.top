import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { fill } from "./copy";
import { type FrontCopy } from "./front-copy";

// The standalone tabletop's account page: sign in, then the account's boards
// (made here, or joined by someone else's link) with what an owner can do
// to them. The Worker's API: docs/internals.md, "Standalone mode".

// avatar is the address of the account's own picture on this origin.
type Account = { avatar: string | null; id: string; name: string };
type Owned = { createdAt: number; id: string; shareCode: string; title: string };
type Visited = { id: string; shareCode: string | null; title: string; visitedAt: number };
type Lists = { owned: Owned[]; visited: Visited[] };

type Me = { account: Account | null; csrf: string | null };

const boardUrl = (shareCode: string) => `${location.origin}/b/${shareCode}`;

function useApi(csrf: string | null) {
  return useCallback(
    (path: string, body: object = {}) =>
      fetch(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
        method: "POST",
      }),
    [csrf],
  );
}

function SignedOut({ copy, failed, name }: { copy: FrontCopy; failed: boolean; name: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 px-4 py-16">
      <h1 className="text-3xl font-semibold">{name}</h1>
      <p className="text-foreground-secondary">{copy.signInHelp}</p>
      {failed && (
        <p className="text-danger-text" role="alert">
          {copy.signInFailed}
        </p>
      )}
      <a className="btn btn-primary min-h-12" href="/auth/sign-in?return=/boards">
        {copy.signIn}
      </a>
      <a className="underline underline-offset-2" href="/">
        {copy.publicBoard}
      </a>
    </div>
  );
}

type Editing = { id: string; kind: "delete" | "rename" | "reset" } | null;

function OwnedRow({
  board,
  copy,
  editing,
  locale,
  onAction,
  setEditing,
}: {
  board: Owned;
  copy: FrontCopy;
  editing: Editing;
  locale: string;
  onAction: (board: Owned, action: "delete" | "rename" | "reset", title?: string) => Promise<void>;
  setEditing: (editing: Editing) => void;
}) {
  const [title, setTitle] = useState(board.title);
  const [copied, setCopied] = useState(false);
  const mode = editing?.id === board.id ? editing.kind : null;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <a
          className="min-w-0 flex-1 truncate text-lg font-medium underline-offset-2 hover:underline"
          href={`/b/${board.shareCode}`}
        >
          {board.title}
        </a>
        <span className="text-sm text-foreground-muted">
          {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(board.createdAt * 1000)}
        </span>
      </div>
      {mode === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="btn btn-secondary min-h-10"
            onClick={() => {
              void navigator.clipboard
                .writeText(boardUrl(board.shareCode))
                .then(() => setCopied(true));
            }}
            type="button"
          >
            {copied ? copy.linkCopied : copy.copyLink}
          </button>
          <button
            className="btn btn-secondary min-h-10"
            onClick={() => setEditing({ id: board.id, kind: "rename" })}
            type="button"
          >
            {copy.rename}
          </button>
          <button
            className="btn btn-secondary min-h-10"
            onClick={() => setEditing({ id: board.id, kind: "reset" })}
            type="button"
          >
            {copy.resetLink}
          </button>
          <button
            className="btn btn-secondary min-h-10"
            onClick={() => setEditing({ id: board.id, kind: "delete" })}
            type="button"
          >
            {copy.delete}
          </button>
        </div>
      )}
      {mode === "rename" && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onAction(board, "rename", title);
          }}
        >
          <label
            className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
            htmlFor={`title-${board.id}`}
          >
            {copy.boardName}
            <input
              autoFocus
              className="h-11 rounded-lg border border-border bg-bg-secondary px-3 text-base focus:border-primary focus:outline-none"
              id={`title-${board.id}`}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <button className="btn btn-primary min-h-11" type="submit">
            {copy.save}
          </button>
          <button
            className="btn btn-secondary min-h-11"
            onClick={() => setEditing(null)}
            type="button"
          >
            {copy.cancel}
          </button>
        </form>
      )}
      {(mode === "reset" || mode === "delete") && (
        <div
          aria-labelledby={`confirm-${board.id}`}
          className="mt-2 rounded-xl bg-bg-tertiary p-3"
          role="alertdialog"
        >
          <p id={`confirm-${board.id}`}>
            {mode === "reset"
              ? copy.resetConfirm
              : fill(copy.deleteConfirm, { title: board.title })}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              autoFocus
              className="btn btn-primary min-h-11"
              onClick={() => void onAction(board, mode)}
              type="button"
            >
              {mode === "reset" ? copy.resetLink : copy.delete}
            </button>
            <button
              className="btn btn-secondary min-h-11"
              onClick={() => setEditing(null)}
              type="button"
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function SignedIn({
  copy,
  locale,
  me,
}: {
  copy: FrontCopy;
  locale: string;
  me: Me & { account: Account };
}) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const post = useApi(me.csrf);

  const load = useCallback(async () => {
    const response = await fetch("/api/boards");
    if (response.ok) setLists((await response.json()) as Lists);
    else setError(copy.actionFailed);
  }, [copy]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    const title = fill(copy.newBoardTitle, {
      date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(new Date()),
    });
    const response = await post("/api/boards", { title });
    if (response.status === 201) {
      const board = (await response.json()) as Owned;
      location.assign(`/b/${board.shareCode}`);
    } else if (response.status === 409) setError(copy.tooManyBoards);
    else if (response.status === 429) setError(copy.tooManyNewBoards);
    else setError(copy.actionFailed);
  };

  const act = async (board: Owned, action: "delete" | "rename" | "reset", title?: string) => {
    setError(null);
    const response = await post(
      `/api/boards/${board.id}/${action}`,
      title === undefined ? {} : { title },
    );
    if (!response.ok) setError(copy.actionFailed);
    setEditing(null);
    await load();
  };

  const signOut = async () => {
    const response = await post("/auth/sign-out");
    const { redirect } = (await response.json().catch(() => ({ redirect: "/" }))) as {
      redirect: string;
    };
    location.assign(redirect);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-16">
      <header className="flex flex-wrap items-center gap-3">
        {/* NOTE: `a:<id>` is the person's id on a board, so the ring is their cursor's colour there. */}
        <Avatar
          color={colorFor(`a:${me.account.id}`)}
          name={me.account.name}
          size="md"
          src={me.account.avatar}
        />
        <p className="min-w-0 flex-1 text-sm text-foreground-secondary">
          {fill(copy.signedInAs, { name: me.account.name })}
        </p>
        <button className="btn btn-secondary min-h-10" onClick={() => void signOut()} type="button">
          {copy.signOut}
        </button>
      </header>
      <a className="mt-4 inline-block underline underline-offset-2" href="/">
        {copy.publicBoard}
      </a>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-semibold">{copy.yourBoards}</h1>
        <button className="btn btn-primary min-h-12" onClick={() => void create()} type="button">
          {copy.newBoard}
        </button>
      </div>
      {error !== null && (
        <p className="mt-3 text-danger-text" role="alert">
          {error}
        </p>
      )}
      {lists === null ? (
        <p className="mt-6 text-foreground-muted" role="status">
          {copy.loading}
        </p>
      ) : (
        <>
          {lists.owned.length === 0 ? (
            <p className="mt-6 text-foreground-muted">{copy.noBoardsYet}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {lists.owned.map((board) => (
                <OwnedRow
                  board={board}
                  copy={copy}
                  editing={editing}
                  key={board.id}
                  locale={locale}
                  onAction={act}
                  setEditing={setEditing}
                />
              ))}
            </ul>
          )}
          {lists.visited.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">{copy.visited}</h2>
              <ul className="mt-2 divide-y divide-border">
                {lists.visited.map((board) => (
                  <li className="flex items-center gap-3 py-3" key={board.id}>
                    {board.shareCode === null ? (
                      <>
                        <span className="min-w-0 flex-1 truncate">{board.title}</span>
                        <span className="text-sm text-foreground-muted">{copy.linkWasReset}</span>
                      </>
                    ) : (
                      <a
                        className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
                        href={`/b/${board.shareCode}`}
                      >
                        {board.title}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Front({ copy, locale, name }: { copy: FrontCopy; locale: string; name: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const failed = new URL(location.href).searchParams.get("sign-in") === "failed";
  useEffect(() => {
    void fetch("/api/me")
      .then(async (response) =>
        response.ok ? ((await response.json()) as Me) : { account: null, csrf: null },
      )
      .catch(() => ({ account: null, csrf: null }))
      .then(setMe);
  }, []);
  if (me === null) {
    return (
      <p className="p-6 text-foreground-muted" role="status">
        {copy.loading}
      </p>
    );
  }
  return me.account === null ? (
    <SignedOut copy={copy} failed={failed} name={name} />
  ) : (
    <SignedIn copy={copy} locale={locale} me={{ ...me, account: me.account }} />
  );
}

export function mountFront(
  element: HTMLElement,
  props: { copy: FrontCopy; locale: string; name: string },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  createRoot(element).render(<Front {...props} />);
}
