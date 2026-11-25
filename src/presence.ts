import { createUserId } from "@tldraw/tlschema";

export type Stamp = { avatar: string | null; name: string; sub: string };

/** Stamps the verified identity onto a presence push instead of trusting client fields. */
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
    // WARNING: Accepting identity fields in a presence patch would let a client impersonate another person.
    delete fields.userId;
    delete fields.userName;
    delete fields.meta;
  }
}
