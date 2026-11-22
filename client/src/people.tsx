import { createUserId, type Editor, type TLPageId, useValue } from "tldraw";

import { usePageNames } from "./pages";
import { Sheet } from "./sheet";
import { useBoardUi } from "./ui";

type Person = { color: string; id: string; name: string };

export type Present = Person & { page: TLPageId };

// tldraw's user ids carry a prefix of their own (createUserId); the pass's
// person id ("u:12", "g:abc") is what follows it.
const personId = (userId: string) => userId.replace(/^user:/u, "");

// One entry per person, though one person may have the board open twice,
// with the page they are on.
export function usePresent(editor: Editor | null): Present[] {
  return useValue(
    "people at the board",
    () => {
      const seen = new Map<string, Present>();
      for (const presence of editor?.getCollaborators() ?? []) {
        const id = personId(presence.userId);
        if (!seen.has(id)) {
          seen.set(id, {
            color: presence.color,
            id,
            name: presence.userName,
            page: presence.currentPageId,
          });
        }
      }
      return [...seen.values()];
    },
    [editor],
  );
}

const isGuest = (id: string) => id.startsWith("g:");

function Who({ page, who }: { page: string | undefined; who: Person }) {
  const { copy, person } = useBoardUi();
  return (
    <>
      <span
        aria-hidden="true"
        className="size-3 shrink-0 rounded-full ring-2 ring-bg-secondary"
        style={{ backgroundColor: who.color }}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{who.name}</span>
          {who.id === person.id && (
            <span className="shrink-0 text-sm text-foreground-muted">({copy.you})</span>
          )}
          {isGuest(who.id) && (
            <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-foreground-secondary ring-1 ring-border">
              {copy.guest}
            </span>
          )}
        </span>
        {page !== undefined && (
          <span className="truncate text-sm text-foreground-muted">{page}</span>
        )}
      </span>
    </>
  );
}

// Tapping someone follows them with tldraw's own follow: to their page, and
// along as they look around, until this person moves the board themself.
export function PeopleSheet() {
  const { color, copy, editor, locale, open, person } = useBoardUi();
  const pages = usePageNames(editor);
  const here = useValue("current page", () => editor?.getCurrentPageId(), [editor]);
  const following = useValue(
    "followed person",
    () => editor?.getInstanceState().followingUserId ?? null,
    [editor],
  );
  const others = usePresent(editor)
    .filter(({ id }) => id !== person.id)
    .toSorted((a, b) => a.name.localeCompare(b.name, locale));
  const pageOf = (page: TLPageId | undefined) =>
    page === undefined ? undefined : pages?.get(page);

  return (
    <Sheet panel="people" title={copy.people}>
      <ul className="divide-y divide-border">
        <li className="flex min-h-12 items-center gap-3">
          <Who page={pageOf(here)} who={{ color, id: person.id, name: person.name }} />
        </li>
        {others.map((present) => {
          const userId = createUserId(present.id);
          const followed = following === userId;
          return (
            <li key={present.id}>
              <button
                className="flex min-h-12 w-full items-center gap-3 rounded-lg py-1 text-left hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus"
                onClick={() => {
                  if (editor === null) return;
                  if (followed) {
                    editor.stopFollowingUser();
                    return;
                  }
                  open(null);
                  editor.startFollowingUser(userId);
                }}
                type="button"
              >
                <Who page={pageOf(present.page)} who={present} />
                <span className="shrink-0 pr-2 text-sm font-medium text-primary-strong">
                  {followed ? copy.stopFollowing : copy.follow}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
