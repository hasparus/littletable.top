import { MAX_PEOPLE } from "./limits";

type Seat = { sessionId: string; meta: { sub: string } };

export function boardSeat(sessions: readonly Seat[], tabId: string, scopedId: string, sub: string) {
  // WARNING: A tab-only seat retained across deployment still belongs to its original player.
  const legacy = sessions.find((seat) => seat.sessionId === tabId && seat.meta.sub === sub);
  if (legacy !== undefined) return { sessionId: tabId };
  const existing = sessions.find((seat) => seat.sessionId === scopedId);
  if (existing !== undefined)
    return existing.meta.sub === sub ? { sessionId: scopedId } : "session-conflict";
  return sessions.length >= MAX_PEOPLE ? "full" : { sessionId: scopedId };
}
