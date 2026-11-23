import { useCallback, useEffect, useState } from "react";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { type FrontCopy } from "./front-copy";

// A board's permissions, for its owner: the accounts that joined by link,
// and for each whether it is a shaman (may connect an assistant to the
// board). Guests have no account and are not listed.

type Joined = { avatar: string | null; id: string; name: string; role: "shaman" | "write" };

type Post = (path: string, body?: object) => Promise<Response>;

export function BoardPeople({
  board,
  copy,
  onClose,
  post,
}: {
  board: { id: string; title: string };
  copy: FrontCopy;
  onClose: () => void;
  post: Post;
}) {
  const [people, setPeople] = useState<Joined[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/boards/${board.id}/people`);
    if (!response.ok) return setFailed(true);
    setPeople(((await response.json()) as { people: Joined[] }).people);
  }, [board.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const setRole = async (person: Joined, shaman: boolean) => {
    setFailed(false);
    const role = shaman ? "shaman" : "write";
    // Shown at once; put back by the reload if the Worker refused.
    setPeople(
      (list) => list?.map((each) => (each.id === person.id ? { ...each, role } : each)) ?? null,
    );
    const response = await post(`/api/boards/${board.id}/people/${person.id}/role`, { role });
    if (!response.ok) setFailed(true);
    await load();
  };

  const heading = `people-${board.id}`;
  return (
    <section aria-labelledby={heading} className="mt-2 rounded-xl bg-bg-tertiary p-3">
      <h3 className="font-semibold" id={heading}>
        {copy.people}
      </h3>
      <p className="mt-1 text-sm text-foreground-secondary">{copy.shamanHelp}</p>
      {failed && (
        <p className="mt-2 text-danger-text" role="alert">
          {copy.actionFailed}
        </p>
      )}
      {people === null && !failed && <p className="mt-3 text-foreground-muted">{copy.loading}</p>}
      {people?.length === 0 && <p className="mt-3 text-foreground-muted">{copy.nobodyJoined}</p>}
      {people !== null && people.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {people.map((person) => (
            <li className="flex min-h-12 items-center gap-3 py-2" key={person.id}>
              <Avatar
                color={colorFor(`a:${person.id}`)}
                name={person.name}
                size="sm"
                src={person.avatar}
              />
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  checked={person.role === "shaman"}
                  className="size-5 accent-primary"
                  onChange={(event) => void setRole(person, event.target.checked)}
                  type="checkbox"
                />
                {copy.shaman}
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-secondary mt-3 min-h-11" onClick={onClose} type="button">
        {copy.done}
      </button>
    </section>
  );
}
