import { TLRemoteSyncError, TLSyncErrorCloseEventReason, useSync } from "@tldraw/sync";
import { useEffect, useMemo, useState } from "react";
import { atom, createUserId, type TLUserStore, UserRecordType } from "tldraw";

import type { BoardFiles } from "./assets";
import type { PassKeeper } from "./bootstrap";
import type { Rolls } from "./rolls";

export type Refusal = "full" | "gone" | "link-reset";

// The Worker accepts a socket it must turn away and closes it at once with
// tldraw's final close code and one of these reasons (docs/hosting.md,
// "Routes").
const REFUSALS: Partial<Record<string, Refusal>> = {
  [TLSyncErrorCloseEventReason.FORBIDDEN]: "link-reset",
  [TLSyncErrorCloseEventReason.NOT_FOUND]: "gone",
  [TLSyncErrorCloseEventReason.ROOM_FULL]: "full",
};

export const refusalOf = (error: Error): Refusal | null =>
  error instanceof TLRemoteSyncError ? (REFUSALS[error.reason] ?? null) : null;

// NOTE: a full board refuses for good as far as tldraw is concerned; the
// board asks again this often, so a person gets in once someone leaves.
const FULL_RETRY_MS = 15_000;

// The board's tldraw store, synced through the Worker. A reset link or a
// deleted board ends the board for this person; a full one waits.
export function useBoardStore({
  color,
  files,
  keeper,
  receiveChat,
  rolls,
}: {
  color: string;
  files: BoardFiles;
  keeper: PassKeeper;
  receiveChat: (message: unknown) => void;
  rolls: Rolls;
}) {
  const { person } = keeper.bootstrap;
  const [attempt, setAttempt] = useState(0);

  const { receive } = rolls;
  // NOTE: useSync reconnects whenever this object changes, so it is built
  // once per board and attempt; a new object on each render loops React.
  const syncOptions = useMemo(() => {
    const users: TLUserStore = {
      currentUser: atom(
        "board person",
        UserRecordType.create({ color, id: createUserId(person.id), name: person.name }),
      ),
    };
    return {
      assets: files.store,
      attempt,
      onCustomMessageReceived: (message: unknown) => {
        receive(message);
        receiveChat(message);
        files.onTextNotice?.(message);
      },
      uri: async () => keeper.socketUri(),
      users,
    };
  }, [attempt, color, files, keeper, person, receive, receiveChat]);
  const store = useSync(syncOptions);
  const refusal = store.status === "error" ? refusalOf(store.error) : null;

  useEffect(() => {
    if (refusal === "gone" || refusal === "link-reset") keeper.end(refusal);
    if (refusal !== "full") return;
    const retry = setTimeout(() => setAttempt((count) => count + 1), FULL_RETRY_MS);
    return () => clearTimeout(retry);
  }, [keeper, refusal]);

  return { refusal, store };
}
