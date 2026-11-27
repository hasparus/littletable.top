import { type ReactNode, useCallback } from "react";

import type { FrontCopy } from "./front-copy";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { fill } from "./copy";
import { FrontMenu, MENU_BUTTON } from "./front-menu";
import { TableMark } from "./icons";

export type Account = { avatar: string | null; id: string; name: string };
type RequestBody = Record<string, string>;
export type Post = (path: string, body?: RequestBody) => Promise<Response>;

export const NAV_LINK =
  "flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-border-focus";

export function useApi(csrf: string | null) {
  return useCallback(
    (path: string, body: RequestBody = {}) =>
      fetch(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
        keepalive: true,
        method: "POST",
      }),
    [csrf],
  );
}

export function FrontFailed({ copy }: { copy: FrontCopy }) {
  return (
    <p className="p-6 text-danger-text" role="alert">
      {copy.actionFailed}
    </p>
  );
}

export function FrontHeader({
  account,
  copy,
  name,
  nav,
  post,
}: {
  account: Account;
  copy: FrontCopy;
  name: string;
  nav: ReactNode;
  post: Post;
}) {
  const signOut = async () => {
    const response = await post("/auth/sign-out");
    // WARNING: SAFETY: Sign-out answers with its redirect; a failed parse falls back to home.
    const { redirect } = (await response.json().catch(() => ({ redirect: "/" }))) as {
      redirect: string;
    };
    location.assign(redirect);
  };
  const accountLabel = fill(copy.signedInAs, { name: account.name });
  return (
    <header className="border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-x-2 px-4 sm:min-h-16 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-1.5 font-[748] tracking-tight lowercase">
          <TableMark className="size-5 shrink-0 sm:size-6" />
          <span className="wrap-anywhere">{name}</span>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {nav}
          <FrontMenu
            label={accountLabel}
            trigger={
              <Avatar
                color={colorFor(`a:${account.id}`)}
                name={account.name}
                src={account.avatar}
              />
            }
          >
            <p className="px-3 py-2 text-sm wrap-anywhere text-foreground-muted">{accountLabel}</p>
            <button className={MENU_BUTTON} onClick={() => void signOut()} type="button">
              {copy.signOut}
            </button>
          </FrontMenu>
        </div>
      </div>
    </header>
  );
}

export function FrontMain({
  actions,
  children,
  intro,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  intro?: string;
  title: string;
}) {
  return (
    <main className="mx-auto max-w-6xl px-4 pt-5 pb-16 sm:px-6 sm:pt-6 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {actions !== undefined && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {intro !== undefined && <p className="mt-2 max-w-prose text-foreground-secondary">{intro}</p>}
      {children}
    </main>
  );
}
