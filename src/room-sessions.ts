import type {
  SessionStateSnapshot,
  TLSocketRoom,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";

import type { Pass } from "./pass";

export type Person = Pick<Pass, "link" | "name" | "owner" | "sessionHash" | "sub"> & {
  avatar: string | null;
};
export type SocketAttachment = {
  sessionId: string;
  person: Person;
} & (
  | { snapshot?: SessionStateSnapshot; stored?: never }
  | { snapshot: SessionStateSnapshot; stored: true }
);
export type RoomSocket = {
  socket: WebSocket;
  connectTimer?: ReturnType<typeof setTimeout>;
  snapshot?: SessionStateSnapshot;
  stored?: boolean;
};

export function closeRoomSessions<SessionMeta>(
  room: TLSocketRoom<TLRecord, SessionMeta> | undefined,
  reason: TLSyncErrorCloseEventReason,
  matches: (person: SessionMeta) => boolean = () => true,
) {
  if (room === undefined) return;
  for (const session of room.getSessions()) {
    if (matches(session.meta)) room.closeSession(session.sessionId, reason);
  }
}
