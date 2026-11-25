import { useState } from "react";

import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { fill } from "./copy";
import { FrontMenu, MENU_BUTTON } from "./front-menu";
import { Icon } from "./icons";

export type Owned = { createdAt: number; id: string; shareCode: string; title: string };
type Visited = { id: string; shareCode: string | null; title: string; visitedAt: number };
export type Lists = { owned: Owned[]; visited: Visited[] };

const DATE_FORMATS = {
  en: new Intl.DateTimeFormat("en", { dateStyle: "medium" }),
  pl: new Intl.DateTimeFormat("pl", { dateStyle: "medium" }),
};
const ACTIONS = ["rename", "reset", "delete"] as const;
export type Action = (typeof ACTIONS)[number];
export type Editing = { id: string; kind: Action } | null;

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(9rem,22%)_9rem] @3xl:gap-x-4";
const BOARD_LINK =
  "col-start-1 row-start-1 self-end rounded-sm font-semibold wrap-anywhere underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus @3xl:self-center";
const BOARD_DATE =
  "col-start-1 row-start-2 self-start text-sm text-foreground-muted tabular-nums @3xl:col-start-2 @3xl:row-start-1 @3xl:self-center";

function BoardDate({
  date,
  format,
  label,
}: {
  date: number;
  format: Intl.DateTimeFormat;
  label: string;
}) {
  const timestamp = new Date(date * 1000);
  return (
    <time className={BOARD_DATE} dateTime={timestamp.toISOString()}>
      {fill(label, { date: format.format(timestamp) })}
    </time>
  );
}

function OwnedRow({
  board,
  copy,
  editing,
  format,
  onAction,
  setEditing,
}: {
  board: Owned;
  copy: FrontCopy;
  editing: Editing;
  format: Intl.DateTimeFormat;
  onAction: (board: Owned, action: Action, title?: string) => Promise<void>;
  setEditing: (editing: Editing) => void;
}) {
  const [title, setTitle] = useState(board.title);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const mode = editing?.id === board.id ? editing.kind : null;
  const shareLabel = copiedCode === board.shareCode ? copy.linkCopied : copy.copyLink;
  const manageLabel = fill(copy.manageBoard, { title: board.title });

  const copyLink = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(`${location.origin}/b/${board.shareCode}`);
      setCopiedCode(board.shareCode);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <li className="py-2">
      <div className={`${ROW} min-h-11`}>
        <a className={BOARD_LINK} href={`/b/${board.shareCode}`}>
          {board.title}
        </a>
        <BoardDate date={board.createdAt} format={format} label={copy.createdOn} />
        <div className="col-start-2 row-span-2 row-start-1 flex items-center justify-self-end @3xl:col-start-3 @3xl:row-span-1">
          <button
            aria-label={shareLabel}
            className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-border-focus"
            onClick={() => void copyLink()}
            title={shareLabel}
            type="button"
          >
            <Icon className="size-4" name="Link" />
            <span className="hidden sm:inline">{shareLabel}</span>
          </button>
          <FrontMenu label={manageLabel} trigger={<Icon className="size-4" name="More" />}>
            {ACTIONS.map((kind) => (
              <button
                className={kind === "delete" ? `${MENU_BUTTON} text-danger-text` : MENU_BUTTON}
                key={kind}
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  setTitle(board.title);
                  setEditing({ id: board.id, kind });
                }}
                type="button"
              >
                {kind === "reset" ? copy.resetLink : copy[kind]}
              </button>
            ))}
          </FrontMenu>
        </div>
      </div>
      <span className="sr-only" role="status">
        {copiedCode === board.shareCode && copy.linkCopied}
      </span>
      {copyFailed && (
        <p className="text-sm text-danger-text" role="alert">
          {copy.actionFailed}
        </p>
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
        <dialog
          aria-labelledby={`confirm-${board.id}`}
          className="static mt-2 w-full rounded-xl bg-bg-secondary p-3 text-foreground"
          open
          role="alertdialog"
        >
          <p id={`confirm-${board.id}`}>
            {mode === "reset"
              ? copy.resetConfirm
              : fill(copy.deleteConfirm, { title: board.title })}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className="btn btn-primary min-h-11"
              onClick={() => void onAction(board, mode)}
              type="button"
            >
              {mode === "reset" ? copy.resetLink : copy.delete}
            </button>
            <button
              autoFocus
              className="btn btn-secondary min-h-11"
              onClick={() => setEditing(null)}
              type="button"
            >
              {copy.cancel}
            </button>
          </div>
        </dialog>
      )}
    </li>
  );
}

export function BoardList({
  copy,
  editing,
  lists,
  locale,
  onAction,
  setEditing,
}: {
  copy: FrontCopy;
  editing: Editing;
  lists: Lists;
  locale: Language;
  onAction: (board: Owned, action: Action, title?: string) => Promise<void>;
  setEditing: (editing: Editing) => void;
}) {
  const format = DATE_FORMATS[locale];
  const hasVisited = lists.visited.length > 0;
  return (
    <div
      className={
        hasVisited ? "mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]" : "mt-6"
      }
    >
      <section aria-labelledby="owned-boards" className="@container min-w-0">
        <h2
          className={hasVisited ? "sr-only lg:not-sr-only lg:mb-2 lg:font-semibold" : "sr-only"}
          id="owned-boards"
        >
          {copy.owned}
        </h2>
        {lists.owned.length === 0 ? (
          <p className="border-t border-border py-4 text-foreground-muted">{copy.noBoardsYet}</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {lists.owned.map((board) => (
              <OwnedRow
                board={board}
                copy={copy}
                editing={editing}
                format={format}
                key={board.id}
                onAction={onAction}
                setEditing={setEditing}
              />
            ))}
          </ul>
        )}
      </section>
      {hasVisited && (
        <section
          aria-labelledby="joined-boards"
          className="@container min-w-0 self-start lg:-mt-3 lg:rounded-xl lg:bg-bg-secondary lg:px-4 lg:pt-3 lg:pb-2"
        >
          <h2 className="mb-2 font-semibold" id="joined-boards">
            {copy.visited}
          </h2>
          <ul className="divide-y divide-border border-t border-border">
            {lists.visited.map((board) => (
              <li className={`${ROW} min-h-15 py-2`} key={board.id}>
                {board.shareCode === null ? (
                  <>
                    <span className="self-end wrap-anywhere text-foreground-secondary @3xl:self-center">
                      {board.title}
                    </span>
                    <span className={BOARD_DATE}>{copy.linkWasReset}</span>
                  </>
                ) : (
                  <>
                    <a className={BOARD_LINK} href={`/b/${board.shareCode}`}>
                      {board.title}
                    </a>
                    <BoardDate date={board.visitedAt} format={format} label={copy.joinedOn} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
