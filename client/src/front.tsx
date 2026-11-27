import { useState } from "react";

import type { Language } from "../settings";
import type { Action, Editing, Lists, Owned, PendingDeletion } from "./front-board-list";

import { fill } from "./copy";
import { useFeedback } from "./feedback";
import { BoardList } from "./front-board-list";
import { type FrontCopy } from "./front-copy";
import {
  type Account,
  FrontFailed,
  FrontHeader,
  FrontMain,
  NAV_LINK,
  useApi,
} from "./front-layout";
import { type Loaded, loadBoards } from "./front-page";
import { Icon } from "./icons";

export type BoardPage = Lists & { account: Account; csrf: string };

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

  const act = async (board: PendingDeletion, action: Action, title?: string) => {
    setError(null);
    const response = await post(
      `/api/boards/${board.id}/${action}`,
      title === undefined ? {} : { title },
    );
    if (!response.ok) setError(copy.actionFailed);
    setEditing(null);
    await reload();
  };

  return (
    <>
      <FrontHeader
        account={me.account}
        copy={copy}
        name={name}
        nav={
          <a className={NAV_LINK} href="/">
            {copy.publicBoardLink}
            <Icon className="hidden size-3.5 sm:block" name="ArrowUpRight" />
          </a>
        }
        post={post}
      />
      <FrontMain
        actions={
          <>
            {feedback !== null && (
              <button
                className="btn btn-secondary min-h-11"
                onClick={(event) =>
                  feedback.open({ role: "member", screen: "boards" }, event.currentTarget)
                }
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
          </>
        }
        title={copy.yourBoards}
      >
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
          post={post}
          setEditing={setEditing}
        />
      </FrontMain>
    </>
  );
}

export function Front({
  copy,
  failed,
  initialPage,
  locale,
  name,
}: {
  copy: FrontCopy;
  failed?: boolean;
  initialPage: Loaded<BoardPage>;
  locale: Language;
  name: string;
}) {
  const [page, setPage] = useState(initialPage);
  const reload = async () => setPage(await loadBoards());
  if (page === "failed") return <FrontFailed copy={copy} />;
  return page === "signed-out" ? (
    <SignedOut copy={copy} failed={failed === true} name={name} />
  ) : (
    <SignedIn copy={copy} locale={locale} me={page} name={name} reload={reload} />
  );
}
