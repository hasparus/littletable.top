import type { BoardPage } from "./front";
import type { AssistantsPage } from "./front-assistants";

/** The pages outside a board, by path: the board list and the assistants' access. */
export const FRONT_VIEWS = { "/assistants": "assistants", "/boards": "boards" } as const;
export type FrontView = (typeof FRONT_VIEWS)[keyof typeof FRONT_VIEWS];

/** Which front page serves `pathname`, if any. */
export function frontView(pathname: string) {
  return pathname === "/assistants" || pathname === "/boards" ? FRONT_VIEWS[pathname] : null;
}

/** A front page as the client knows it: its data, or why there is none. */
export type Loaded<Page> = "failed" | "signed-out" | Page;

/** What the Worker renders and serializes for hydration, per view. */
export type FrontPage =
  | { failed: boolean; initialPage: Loaded<BoardPage>; view: "boards" }
  | { initialPage: Loaded<AssistantsPage>; view: "assistants" };

export const ASSISTANTS_SIGN_IN = "/auth/sign-in?return=/assistants";

export type AssistantAccess = "off" | "read" | "write";

/** A board the account owns or manages, and the access one client has to it. */
export type AssistantBoard = {
  access: AssistantAccess;
  hasThumbnail: boolean;
  id: string;
  role: "owner" | "manager";
  title: string;
};

async function load<Page>(path: string) {
  try {
    const response = await fetch(path);
    if (response.status === 401) return "signed-out" as const;
    if (!response.ok) return "failed" as const;
    // WARNING: SAFETY: The Worker answers this path with the page it renders for hydration.
    const page = (await response.json()) as Page;
    return page;
  } catch {
    return "failed" as const;
  }
}

/** Loads a front page's data when the Worker did not render it, as under the Vite dev server. */
export async function loadFront(view: FrontView) {
  const page: FrontPage =
    view === "assistants"
      ? { initialPage: await load<AssistantsPage>("/api/assistants"), view }
      : {
          failed: new URL(location.href).searchParams.get("sign-in") === "failed",
          initialPage: await load<BoardPage>("/api/boards"),
          view,
        };
  return page;
}

/** Reloads the board list after an action on one of its boards. */
export const loadBoards = () => load<BoardPage>("/api/boards");
