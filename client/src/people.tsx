import { useEffect } from "react";
import { createUserId, type Editor, type TLPageId, useValue } from "tldraw";

import { Avatar } from "./avatar";
import { usePageNames } from "./pages";
import { Sheet } from "./sheet";
import { useBoardUi } from "./ui";

type Person = { avatar: string | null; color: string; id: string; name: string };

export type Present = Person & { page: TLPageId };

// WARNING: tldraw adds its own user: prefix before the pass's member or guest identifier.
const personId = (userId: string) => userId.replace(/^user:/u, "");

const avatarOf = (meta: Record<string, unknown>) =>
  typeof meta.avatar === "string" && /^[0-9a-f]{64}$/u.test(meta.avatar) ? meta.avatar : null;

/**
 * One entry per person, though one person may have the board open twice,
 * with the page they are on.
 */
export function usePresent(editor: Editor | null): Present[] {
  return useValue(
    "people at the board",
    () => {
      const seen = new Map<string, Present>();
      for (const presence of editor?.getCollaborators() ?? []) {
        const id = personId(presence.userId);
        if (!seen.has(id)) {
          seen.set(id, {
            avatar: avatarOf(presence.meta),
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
  const { copy, files, person } = useBoardUi();
  // WARNING: Requesting an avatar before the files cookie is set leaves the fallback initial in place.
  const readable = useValue("files readable", () => files.readable.get(), [files]);
  const src = readable && who.avatar !== null ? `${files.path}/avatars/${who.avatar}` : null;
  return (
    <>
      <Avatar color={who.color} name={who.name} src={src} />
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

export function PeopleSheet() {
  const { color, copy, editor, files, locale, open, person } = useBoardUi();
  const ownAvatar = useValue("own avatar", () => files.avatar.get(), [files]);
  useEffect(() => files.keepReadable(), [files]);
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
          <Who
            page={pageOf(here)}
            who={{
              avatar: ownAvatar?.split("/").at(-1) ?? null,
              color,
              id: person.id,
              name: person.name,
            }}
          />
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
