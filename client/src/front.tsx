import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Language } from "../settings";
import type { Action, Editing, Lists, Owned } from "./front-board-list";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { fill } from "./copy";
import { BoardList } from "./front-board-list";
import { type FrontCopy } from "./front-copy";
import { FrontMenu, MENU_BUTTON } from "./front-menu";
import { Icon } from "./icons";

// The standalone tabletop's account page: sign in, then the account's boards
// (made here, or joined by someone else's link) with what an owner can do
// to them. The Worker's API: docs/internals.md, "Standalone mode".

// avatar is the address of the account's own picture on this origin.
type Account = { avatar: string | null; id: string; name: string };

type Me = { account: Account | null; csrf: string | null };

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

function SignedIn({
  copy,
  locale,
  me,
  name,
}: {
  copy: FrontCopy;
  locale: Language;
  me: Me & { account: Account };
  name: string;
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
    const response = await post("/api/boards", { language: locale, title });
    if (response.status === 201) {
      const board = (await response.json()) as Owned;
      location.assign(`/b/${board.shareCode}`);
    } else if (response.status === 409) setError(copy.tooManyBoards);
    else if (response.status === 429) setError(copy.tooManyNewBoards);
    else setError(copy.actionFailed);
  };

  const act = async (board: Owned, action: Action, title?: string) => {
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

  const accountLabel = fill(copy.signedInAs, { name: me.account.name });
  return (
    <>
      <header className="border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-x-2 px-4 sm:min-h-16 sm:px-6 lg:px-10">
          <div className="flex min-w-0 items-center gap-1.5 font-[748] tracking-tight lowercase">
            <img alt="" className="size-5 shrink-0 sm:size-6" src="/favicon.svg" />
            <span className="wrap-anywhere">{name}</span>
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <a
              className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
              href="/"
            >
              {copy.publicBoard}
              <Icon className="hidden size-3.5 sm:block" name="ArrowUpRight" />
            </a>
            <FrontMenu
              label={accountLabel}
              trigger={
                <Avatar
                  color={colorFor(`a:${me.account.id}`)}
                  name={me.account.name}
                  src={me.account.avatar}
                />
              }
            >
              <p className="px-3 py-2 text-sm wrap-anywhere text-foreground-muted">
                {accountLabel}
              </p>
              <button className={MENU_BUTTON} onClick={() => void signOut()} type="button">
                {copy.signOut}
              </button>
            </FrontMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-5 pb-16 sm:px-6 sm:pt-6 lg:px-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{copy.yourBoards}</h1>
          <button className="btn btn-primary min-h-11" onClick={() => void create()} type="button">
            <Icon className="size-4" name="Plus" />
            {copy.newBoard}
          </button>
        </div>
        {error !== null && (
          <p className="mt-3 text-danger-text" role="alert">
            {error}
          </p>
        )}
        {lists === null ? (
          error === null && (
            <p className="mt-6 text-foreground-muted" role="status">
              {copy.loading}
            </p>
          )
        ) : (
          <BoardList
            copy={copy}
            editing={editing}
            lists={lists}
            locale={locale}
            onAction={act}
            setEditing={setEditing}
          />
        )}
      </main>
    </>
  );
}

function Front({ copy, locale, name }: { copy: FrontCopy; locale: Language; name: string }) {
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
    <SignedIn copy={copy} locale={locale} me={{ ...me, account: me.account }} name={name} />
  );
}

export function mountFront(
  element: HTMLElement,
  props: { copy: FrontCopy; locale: Language; name: string },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  createRoot(element).render(<Front {...props} />);
}
