import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";

import { activeSessionExpiry } from "./standalone/store";

const CHECK_INTERVAL_MS = 30_000;

type VerifiedSession = { expiry: number; deadline: number };

export class PrivateBoardSockets {
  private readonly sessions = new Map<string, VerifiedSession | "revoked">();

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
    private readonly db: D1Database | undefined,
    private readonly sessionHash: (socket: WebSocket) => string | undefined,
  ) {}

  hasSessions(sockets: WebSocket[]) {
    return sockets.some((socket) => this.sessionHash(socket) !== undefined);
  }

  revoke(hash: string) {
    this.sessions.set(hash, "revoked");
  }

  async authorize(hash: string) {
    const verified = await this.verify(hash);
    if (verified !== "allowed") return verified;
    await this.schedule();
    return this.access(hash);
  }

  async refresh(sockets: WebSocket[]) {
    const hashes = new Set<string>();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const hash = this.sessionHash(socket);
      if (hash !== undefined) hashes.add(hash);
    }
    for (const hash of this.sessions.keys()) {
      if (!hashes.has(hash)) this.sessions.delete(hash);
    }
    await Promise.all(Array.from(hashes, (hash) => this.verify(hash)));
    await this.schedule();
  }

  async recheckConnected(sockets: WebSocket[]) {
    await this.refresh(sockets);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) this.mayUse(socket, this.sessionHash(socket));
    }
  }

  mayUse(socket: WebSocket, hash: string | undefined) {
    if (hash === undefined) return true;
    switch (this.access(hash)) {
      case "allowed":
        return true;
      case "revoked":
        socket.close(TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason.FORBIDDEN);
        return false;
      case "unavailable":
        socket.close(1012, "Session verification unavailable");
        return false;
    }
  }

  transport(socket: WebSocket, hash: string | undefined) {
    // WARNING: Hibernatable WebSockets deliver events to the object instead of socket listeners.
    return {
      get readyState() {
        return socket.readyState;
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
      send: (message: string) => {
        if (this.mayUse(socket, hash)) socket.send(message);
      },
    };
  }

  private access(hash: string) {
    const session = this.sessions.get(hash);
    if (session === undefined) return "unavailable";
    const now = Date.now();
    if (session === "revoked" || session.expiry <= now) return "revoked";
    return session.deadline > now ? "allowed" : "unavailable";
  }

  private async verify(hash: string) {
    const started = Date.now();
    try {
      const expiry = await activeSessionExpiry(this.db, hash);
      if (expiry === null) {
        this.revoke(hash);
      } else {
        this.sessions.set(hash, {
          deadline: Math.min(expiry, started + 2 * CHECK_INTERVAL_MS),
          expiry,
        });
      }
      return this.access(hash);
    } catch {
      // WARNING: Never extend a deadline when its recheck fails.
      console.log(JSON.stringify({ event: "board.private_session_check_failed" }));
      return "unavailable";
    }
  }

  private async schedule() {
    const now = Date.now();
    let next = Infinity;
    for (const session of this.sessions.values()) {
      if (session !== "revoked" && session.deadline > now) {
        next = Math.min(next, now + CHECK_INTERVAL_MS, session.deadline);
      }
    }
    if (next === Infinity) return;
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || scheduled > next) await this.storage.setAlarm(next);
  }
}
