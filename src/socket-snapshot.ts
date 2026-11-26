import type { SessionStateSnapshot } from "@tldraw/sync-core";

export const SOCKET_SNAPSHOT_PREFIX = "socketSnapshot:";

export type SocketAttachment<Person> = {
  sessionId: string;
  person: Person;
} & (
  | { snapshot?: SessionStateSnapshot; stored?: never }
  | { snapshot: SessionStateSnapshot; stored: true }
);

export type SocketSnapshotState = {
  socket: WebSocket;
  snapshot?: SessionStateSnapshot;
  stored?: boolean;
};

export function readSocketAttachment<Person>(socket: WebSocket) {
  const attachment: SocketAttachment<Person> | null = socket.deserializeAttachment();
  return attachment;
}

export function saveSocketSnapshot<Person>(
  kv: DurableObjectStorage["kv"],
  connection: SocketSnapshotState,
  { person, sessionId }: SocketAttachment<Person>,
  snapshot: SessionStateSnapshot,
  compact: SessionStateSnapshot,
) {
  const previous = connection.snapshot;
  if (
    previous?.serializedSchema === snapshot.serializedSchema &&
    previous.presenceRecord === snapshot.presenceRecord
  ) {
    return true;
  }

  const key = SOCKET_SNAPSHOT_PREFIX + sessionId;
  try {
    connection.socket.serializeAttachment({
      person,
      sessionId,
      snapshot,
    } satisfies SocketAttachment<Person>);
    if (connection.stored === true) {
      kv.delete(key);
      connection.stored = false;
    }
  } catch {
    try {
      kv.put(key, snapshot);
      connection.stored = true;
      connection.socket.serializeAttachment({
        person,
        sessionId,
        snapshot: compact,
        stored: true,
      } satisfies SocketAttachment<Person>);
    } catch {
      return false;
    }
  }
  connection.snapshot = snapshot;
  return true;
}
