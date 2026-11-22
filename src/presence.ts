// Who a person is on the board comes from their pass, never from their own
// client: tldraw sync lets each client write its own presence record, so
// the room stamps the pass's id, name and picture over whatever a client
// sends. Nobody can then show up as someone else, or under a picture that
// is not theirs or not one the Worker copied.

import { createUserId } from "@tldraw/tlschema";

export type Stamp = { avatar: string | null; name: string; sub: string };

// The presence a push carries: ["put", record] or ["patch", diff].
export function stampPresence(message: unknown, stamp: Stamp): void {
  if (typeof message !== "object" || message === null || !("presence" in message)) return;
  const { presence } = message;
  if (!Array.isArray(presence)) return;
  const [op, value] = presence as [unknown, unknown];
  if (typeof value !== "object" || value === null) return;
  const fields = value as Record<string, unknown>;
  if (op === "put") {
    fields.userId = createUserId(stamp.sub);
    fields.userName = stamp.name;
    fields.meta = { avatar: stamp.avatar };
  } else {
    // NOTE: a patch can only follow the put above, which already holds
    // the right values; any change to them is dropped.
    delete fields.userId;
    delete fields.userName;
    delete fields.meta;
  }
}
