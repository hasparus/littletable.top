import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Language } from "../settings";
import type { Action, Editing, Lists, Owned } from "./front-board-list";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { fill } from "./copy";
import { FeedbackProvider, useFeedback } from "./feedback";
import { BoardList } from "./front-board-list";
import { type FrontCopy } from "./front-copy";
import { FrontMenu, MENU_BUTTON } from "./front-menu";
import { boardShell } from "./front-skeleton";
import { Icon, TableMark } from "./icons";

// The standalone tabletop's account page: sign in, then the account's boards
// (made here, or joined by someone else's link) with what an owner can do
// to them. The Worker's API: docs/internals.md, "Standalone mode".

// avatar is the address of the account's own picture on this origin.
type Account = { avatar: string | null; id: string; name: string };

type BoardPage = Lists & { account: Account; csrf: string };

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
        {copy.publicBoardLink}
      </a>
    </div>
  );
}

function SignedIn({
  copy,
  locale,
  me,
  name,
  reload,
}: {
  copy: FrontCopy;
  locale: Language;
  me: BoardPage;
  name: string;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const post = useApi(me.csrf);
  const feedback = useFeedback();

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
    await reload();
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
            <TableMark className="size-5 shrink-0 sm:size-6" />
            <span className="wrap-anywhere">{name}</span>
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <a
              className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
              href="/"
            >
              {copy.publicBoardLink}
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
          <div className="flex flex-wrap items-center gap-2">
            {feedback !== null && (
              <button
                className="btn btn-secondary min-h-11"
                onClick={() => feedback.open({ role: "member", screen: "boards" })}
                type="button"
              >
                {feedback.label}
              </button>
            )}
            <button
              className="btn btn-primary min-h-11 font-semibold"
              onClick={() => void create()}
              type="button"
            >
              {copy.newBoard}
              <Icon className="size-4 stroke-current stroke-1" name="Plus" />
            </button>
          </div>
        </div>
        {error !== null && (
          <p className="mt-3 text-danger-text" role="alert">
            {error}
          </p>
        )}
        <BoardList
          copy={copy}
          editing={editing}
          lists={me}
          locale={locale}
          onAction={act}
          setEditing={setEditing}
        />
      </main>
    </>
  );
}

function Front({ copy, locale, name }: { copy: FrontCopy; locale: Language; name: string }) {
  const [page, setPage] = useState<"failed" | "signed-out" | BoardPage | null>(null);
  const failed = new URL(location.href).searchParams.get("sign-in") === "failed";
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/boards");
      if (response.status === 401) setPage("signed-out");
      else if (response.ok) setPage((await response.json()) as BoardPage);
      else setPage("failed");
    } catch {
      setPage("failed");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (page === "failed") {
    return (
      <p className="p-6 text-danger-text" role="alert">
        {copy.actionFailed}
      </p>
    );
  }
  if (page === null) {
    return (
      <div role="status">
        <span className="sr-only">{copy.loading}</span>
        <div dangerouslySetInnerHTML={{ __html: boardShell }} />
      </div>
    );
  }
  return page === "signed-out" ? (
    <SignedOut copy={copy} failed={failed} name={name} />
  ) : (
    <SignedIn copy={copy} locale={locale} me={page} name={name} reload={reload} />
  );
}

export function mountFront(
  element: HTMLElement,
  props: { copy: FrontCopy; locale: Language; name: string },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  createRoot(element).render(
    <FeedbackProvider enabled language={props.locale}>
      <Front {...props} />
    </FeedbackProvider>,
  );
}
