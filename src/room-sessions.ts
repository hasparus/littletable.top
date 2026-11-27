import type { TLSocketRoom, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";

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
