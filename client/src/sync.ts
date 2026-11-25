import { TLRemoteSyncError, TLSyncErrorCloseEventReason, useSync } from "@tldraw/sync";
import { getDefaultUserPresence } from "@tldraw/tlschema";
import { useEffect, useMemo, useState } from "react";
import { atom, createUserId, type TLUserStore, UserRecordType } from "tldraw";

import type { BoardFiles } from "./assets";
import type { PassKeeper } from "./bootstrap";
import type { Rolls } from "./rolls";

export type Refusal = "full" | "gone" | "link-reset";

const REFUSALS: Partial<Record<string, Refusal>> = {
  [TLSyncErrorCloseEventReason.FORBIDDEN]: "link-reset",
  [TLSyncErrorCloseEventReason.NOT_FOUND]: "gone",
  [TLSyncErrorCloseEventReason.ROOM_FULL]: "full",
};

export const refusalOf = (error: Error): Refusal | null =>
  error instanceof TLRemoteSyncError ? (REFUSALS[error.reason] ?? null) : null;

// WARNING: tldraw treats a full room as terminal. Retry it here so a slot opening can admit the person.
const FULL_RETRY_MS = 15_000;

export function useBoardStore({
  active,
  color,
  files,
  keeper,
  receiveChat,
  rolls,
}: {
  active: boolean;
  color: string;
  files: BoardFiles;
  keeper: PassKeeper;
  receiveChat: (message: unknown) => void;
  rolls: Rolls;
}) {
  const { person } = keeper.bootstrap;
  const [attempt, setAttempt] = useState(0);

  const { receive } = rolls;
  // WARNING: useSync reconnects when this object changes, so recreating it on every render causes a loop.
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
  const store = useSync({
    ...syncOptions,
    getUserPresence: active ? getDefaultUserPresence : () => null,
  });
  const refusal = store.status === "error" ? refusalOf(store.error) : null;

  useEffect(() => {
    if (refusal === "gone" || refusal === "link-reset") keeper.end(refusal);
    if (refusal !== "full") return;
    const retry = setTimeout(() => setAttempt((count) => count + 1), FULL_RETRY_MS);
    return () => clearTimeout(retry);
  }, [keeper, refusal]);

  return { refusal, store };
}
