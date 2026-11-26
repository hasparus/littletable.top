import { type ReactNode, useState, useSyncExternalStore } from "react";

import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { thumbnailUrl } from "../../src/board-thumbnail";
import { BoardPeople, type BoardRoleChange } from "./board-people";
import { fill } from "./copy";
import { FrontMenu, MENU_BUTTON } from "./front-menu";
import { Icon } from "./icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export type Owned = {
  createdAt: number;
  hasThumbnail?: boolean;
  id: string;
  shareCode: string;
  title: string;
};
type Visited = {
  hasThumbnail?: boolean;
  id: string;
  shareCode: string | null;
  title: string;
  visitedAt: number;
};
export type Lists = { owned: Owned[]; visited: Visited[] };

const DATE_FORMATS = {
  en: new Intl.DateTimeFormat("en", { dateStyle: "medium" }),
  pl: new Intl.DateTimeFormat("pl", { dateStyle: "medium" }),
};
const UTC_DATE_FORMATS = {
  en: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }),
  pl: new Intl.DateTimeFormat("pl", { dateStyle: "medium", timeZone: "UTC" }),
};
const subscribeToDateFormats = () => () => null;
const browserDateFormats = () => DATE_FORMATS;
const serverDateFormats = () => UTC_DATE_FORMATS;
export type Action = "rename" | "reset" | "delete";
const ACTIONS = ["rename", "people", "reset", "delete"] as const;
export type Editing = { id: string; kind: (typeof ACTIONS)[number] } | null;

type Post = (path: string, body: BoardRoleChange) => Promise<Response>;

const ROW =
  "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 @3xl:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,22%)_9rem] @3xl:gap-x-4";
const BOARD_TITLE = "col-start-2 row-start-1 min-w-0 self-end font-semibold @3xl:self-center";
const BOARD_LINK = `${BOARD_TITLE} rounded-sm wrap-anywhere underline-offset-4 after:absolute after:inset-0 after:rounded-sm hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-border-focus`;
const BOARD_DATE =
  "col-start-2 row-start-2 self-start text-sm text-foreground-muted tabular-nums @3xl:col-start-3 @3xl:row-start-1 @3xl:self-center";

function BoardThumbnail({ board }: { board: Owned | Visited }) {
  return (
    <span
      aria-hidden="true"
      className="col-start-1 row-span-2 row-start-1 aspect-video w-18 overflow-hidden rounded-md border border-border bg-bg-secondary sm:w-24 @3xl:row-span-1 @3xl:w-28"
    >
      {board.hasThumbnail === true && board.shareCode !== null && (
        <img
          alt=""
          className="size-full bg-(--light-board-background) object-cover"
          decoding="async"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          src={thumbnailUrl(board.id)}
        />
      )}
    </span>
  );
}

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
  post,
  setEditing,
}: {
  board: Owned;
  copy: FrontCopy;
  editing: Editing;
  format: Intl.DateTimeFormat;
  onAction: (board: Owned, action: Action, title?: string) => Promise<void>;
  post: Post;
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
    <li>
      <div className={`${ROW} min-h-15 py-2`}>
        <BoardThumbnail board={board} />
        {mode === "rename" ? (
          <form
            className={BOARD_TITLE}
            id={`rename-${board.id}`}
            onSubmit={(event) => {
              event.preventDefault();
              void onAction(board, "rename", title);
            }}
          >
            <input
              aria-label={copy.boardName}
              autoFocus
              className="block w-full rounded-sm border border-dashed border-foreground-muted bg-transparent p-0 focus:border-border-focus focus:outline-none"
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(null);
              }}
              required
              value={title}
            />
          </form>
        ) : (
          <a className={BOARD_LINK} href={`/b/${board.shareCode}`}>
            {board.title}
          </a>
        )}
        <BoardDate date={board.createdAt} format={format} label={copy.createdOn} />
        <div className="relative col-start-3 row-span-2 row-start-1 flex items-center justify-self-end @3xl:col-start-4 @3xl:row-span-1">
          {mode === "rename" ? (
            <>
              <button
                className="min-h-11 px-2 text-sm font-semibold"
                form={`rename-${board.id}`}
                type="submit"
              >
                {copy.save}
              </button>
              <button
                className="min-h-11 px-2 text-sm text-foreground-secondary"
                onClick={() => setEditing(null)}
                type="button"
              >
                {copy.cancel}
              </button>
            </>
          ) : (
            <>
              <button
                aria-label={shareLabel}
                className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-border-focus"
                onClick={() => void copyLink()}
                title={shareLabel}
                type="button"
              >
                <Icon className="size-4" name="Link" />
                <span className="hidden @md:inline">{shareLabel}</span>
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
            </>
          )}
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
      {mode === "people" && (
        <BoardPeople boardId={board.id} copy={copy} onClose={() => setEditing(null)} post={post} />
      )}
      {(mode === "reset" || mode === "delete") && (
        <dialog
          aria-labelledby={`confirm-${board.id}`}
          className="static mt-2 w-full rounded-xl bg-bg-secondary p-3 text-foreground"
          open
          data-board-confirmation
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

// WARNING: Keep this aligned with Tailwind's sm breakpoint so DOM order follows the visible layout.
const phoneQuery = "(width < 640px)";
const isPhone = () => matchMedia(phoneQuery).matches;
function subscribeToPhone(listener: () => void) {
  const phoneViewport = matchMedia(phoneQuery);
  phoneViewport.addEventListener("change", listener);
  return () => phoneViewport.removeEventListener("change", listener);
}

function BoardCollection({
  children,
  className = "",
  collapsible,
  label,
  showHeading = true,
}: {
  children: ReactNode;
  className?: string;
  collapsible: boolean;
  label: string;
  showHeading?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = !collapsible || expanded;
  return (
    <Collapsible asChild onOpenChange={setExpanded} open={open}>
      <section className={`@container min-w-0 ${className}`}>
        {collapsible ? (
          <h2 className="font-semibold">
            <CollapsibleTrigger className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-border-focus">
              {label}
              <Icon
                className="size-4 shrink-0 motion-safe:transition-transform group-data-[state=open]:rotate-180"
                name="ChevronDown"
              />
            </CollapsibleTrigger>
          </h2>
        ) : (
          <h2 className={showHeading ? "mb-2 font-semibold" : "sr-only"}>{label}</h2>
        )}
        <CollapsibleContent
          className={
            collapsible
              ? "motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down"
              : undefined
          }
          inert={!open}
        >
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function BoardList({
  copy,
  editing,
  lists,
  locale,
  onAction,
  post,
  setEditing,
}: {
  copy: FrontCopy;
  editing: Editing;
  lists: Lists;
  locale: Language;
  onAction: (board: Owned, action: Action, title?: string) => Promise<void>;
  post: Post;
  setEditing: (editing: Editing) => void;
}) {
  const format = useSyncExternalStore(
    subscribeToDateFormats,
    browserDateFormats,
    serverDateFormats,
  )[locale];
  const phone = useSyncExternalStore(subscribeToPhone, isPhone, () => false);
  const hasVisited = lists.visited.length > 0;
  const collapsible = phone && lists.owned.length > 2 && lists.visited.length > 2;
  const joined = hasVisited ? (
    <BoardCollection collapsible={collapsible} key="joined" label={copy.visited}>
      <ul className="divide-y divide-border border-t border-border">
        {lists.visited.map((board) => (
          <li className={`${ROW} min-h-15 py-2`} key={board.id}>
            <BoardThumbnail board={board} />
            {board.shareCode === null ? (
              <>
                <span className="col-start-2 row-start-1 self-end wrap-anywhere text-foreground-secondary @3xl:self-center">
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
    </BoardCollection>
  ) : null;
  const created = (
    <BoardCollection
      className={
        hasVisited
          ? "self-start lg:-mt-3 lg:rounded-xl lg:bg-bg-secondary lg:px-4 lg:pt-3 lg:pb-2"
          : ""
      }
      collapsible={collapsible}
      key="created"
      label={copy.created}
      showHeading={phone || hasVisited}
    >
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
              post={post}
              setEditing={setEditing}
            />
          ))}
        </ul>
      )}
    </BoardCollection>
  );
  return (
    <div
      className={
        hasVisited
          ? "mt-6 grid gap-4 sm:gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
          : "mt-6"
      }
    >
      {phone ? [created, joined] : [joined, created]}
    </div>
  );
}
