import { useEffect, useState } from "react";

import type { FrontCopy } from "./front-copy";

import { Avatar } from "./avatar";
import { colorFor } from "./colors";

type BoardRole = "shaman" | "write";
export type BoardRoleChange = { role: BoardRole };
type Joined = { avatar: string | null; id: string; name: string; role: BoardRole };

async function loadPeople(path: string, signal: AbortSignal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error("Could not load board members");
  const result: { people: Joined[] } = await response.json();
  return result.people;
}

export function BoardPeople({
  boardId,
  copy,
  onClose,
  post,
}: {
  boardId: string;
  copy: FrontCopy;
  onClose: () => void;
  post: (path: string, body: BoardRoleChange) => Promise<Response>;
}) {
  const [people, setPeople] = useState<Joined[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const peoplePath = `/api/boards/${boardId}/people`;

  // oxlint-disable-next-line landmines-style/no-comments -- React Doctor directive.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Opening the panel loads fresh members; closing it aborts the fetch and guards both callbacks.
  useEffect(() => {
    const controller = new AbortController();
    void loadPeople(peoplePath, controller.signal)
      .then((members) => {
        if (!controller.signal.aborted) setPeople(members);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [peoplePath]);

  const setRole = (person: Joined, manager: boolean) => {
    const role = manager ? "shaman" : "write";
    setFailed(false);
    setSaving(true);
    void post(`${peoplePath}/${person.id}/role`, { role })
      .then(
        (response) => {
          if (!response.ok) {
            setFailed(true);
            return;
          }
          setPeople(
            (list) =>
              list?.map((each) => (each.id === person.id ? { ...each, role } : each)) ?? null,
          );
        },
        () => setFailed(true),
      )
      .finally(() => setSaving(false));
  };

  const heading = `people-${boardId}`;
  return (
    <section aria-labelledby={heading} className="mt-2 rounded-xl bg-bg-tertiary p-3">
      <h3 className="font-semibold" id={heading}>
        {copy.people}
      </h3>
      <p className="mt-1 text-sm text-foreground-secondary">{copy.managerHelp}</p>
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
                  disabled={saving}
                  onChange={(event) => setRole(person, event.target.checked)}
                  type="checkbox"
                />
                {copy.manager}
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
