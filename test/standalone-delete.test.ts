import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { FileLedger } from "../src/file-store";

import { fileKey } from "../src/file-store";
import { secretLayerOf } from "../src/secret-layer";
import { thumbnailKey } from "../src/thumbnail-store";
import { Browser, openSocket, ORIGIN, roomCall, standaloneEnv } from "./standalone-support";

type Answer = { board: string; pass: string; secretPass: string };

describe("deleting a board", () => {
  it("forgets it, wipes its room and puts everyone out", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const own: Answer = await (await ada.bootstrap(board.shareCode)).json();
    await roomCall(`/rooms/${own.board}/roll`, own.pass, {
      body: JSON.stringify({ dice: [20] }),
      method: "POST",
    });
    const seated = await openSocket(own.board, own.pass);

    expect((await ada.post(`/api/boards/${board.id}/delete`)).status).toBe(204);

    expect(await seated.closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_FOUND,
    });
    expect((await ada.list()).owned).toEqual([]);
    expect((await ada.bootstrap(board.shareCode)).status).toBe(404);
  });

  it("keeps the board listed when a room cannot receive retirement", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    const board = await owner.createBoard();
    const { pass, secretPass } = await (await owner.bootstrap(board.shareCode)).json<Answer>();
    const secret = secretLayerOf(board.id);
    const [sharedSocket, secretSocket] = await Promise.all([
      openSocket(board.id, pass),
      openSocket(secret, secretPass),
    ]);

    const namespace = standaloneEnv.BoardRoom;
    const unreachable = namespace.idFromName(board.id).toString();
    const envWithFailedRpc = {
      ...standaloneEnv,
      BoardRoom: new Proxy(namespace, {
        get(target, property) {
          if (property === "idFromName") return target.idFromName.bind(target);
          if (property !== "get") return Reflect.get(target, property, target);
          return (id: DurableObjectId) => {
            if (id.toString() === unreachable) {
              return {
                markRetired() {
                  return Promise.reject(new Error("Room unavailable before retirement"));
                },
              };
            }
            return target.get(id);
          };
        },
      }),
    };
    const endpoint = `/api/boards/${board.id}/delete`;
    await expect(
      owner.fetch(
        endpoint,
        {
          body: "{}",
          headers: {
            "Content-Type": "application/json",
            Origin: ORIGIN,
            "X-CSRF-Token": owner.csrf!,
          },
          method: "POST",
        },
        envWithFailedRpc,
      ),
    ).rejects.toThrow("Room unavailable before retirement");

    expect((await owner.list()).owned).toMatchObject([board]);
    expect(sharedSocket.socket?.readyState).toBe(WebSocket.OPEN);
    const closed = {
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_FOUND,
    };
    expect(await secretSocket.closure).toEqual(closed);
    expect((await roomCall(`/rooms/${board.id}/rolls`, pass)).status).toBe(200);

    // A fresh board-list request can retry the same deletion after either room is already retired.
    const retries = await Promise.all([owner.post(endpoint), owner.post(endpoint)]);
    const statuses = retries.map(({ status }) => status);
    expect(statuses).toContain(204);
    expect(statuses.every((status) => status === 204 || status === 404)).toBe(true);
    expect(await sharedSocket.closure).toEqual(closed);
    expect((await owner.list()).owned).toEqual([]);
    expect((await owner.bootstrap(board.shareCode)).status).toBe(404);
  });

  it("closes both rooms and lets only the owner retry a failed file cleanup", async () => {
    const owner = new Browser();
    const other = new Browser();
    await owner.signIn("Ada");
    await other.signIn("Bea");
    const board = await owner.createBoard("Map to retire");
    const secret = secretLayerOf(board.id);
    const { pass, secretPass } = await (await owner.bootstrap(board.shareCode)).json<Answer>();
    expect((await other.bootstrap(board.shareCode)).status).toBe(200);
    const [sharedSocket, secretSocket] = await Promise.all([
      openSocket(board.id, pass),
      openSocket(secret, secretPass),
    ]);
    const sharedFile = fileKey(board.id, "shared");
    const secretFile = fileKey(secret, "private");
    const thumbnail = thumbnailKey(board.id);
    const { BoardRoom, Files } = standaloneEnv;
    await Promise.all([sharedFile, secretFile, thumbnail].map((key) => Files.put(key, "image")));
    const secretRoom = BoardRoom.get(BoardRoom.idFromName(secret));
    expect(
      (
        await roomCall(`/rooms/${secret}/roll`, secretPass, {
          body: JSON.stringify({ dice: [20] }),
          method: "POST",
        })
      ).status,
    ).toBe(200);
    await runInDurableObject(secretRoom, (room) => {
      const ledger = Reflect.get(room, "files") as FileLedger;
      vi.spyOn(ledger, "wipe").mockRejectedValueOnce(new Error("File storage unavailable"));
    });

    const endpoint = `/api/boards/${board.id}/delete`;
    await expect(owner.post(endpoint)).rejects.toThrow("File storage unavailable");
    const closed = {
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_FOUND,
    };
    expect(await sharedSocket.closure).toEqual(closed);
    expect(await secretSocket.closure).toEqual(closed);
    expect(await Files.head(sharedFile)).toBeNull();
    expect(await Files.head(thumbnail)).not.toBeNull();
    expect((await owner.bootstrap(board.shareCode)).status).toBe(404);
    expect(await (await openSocket(board.id, pass)).closure).toEqual(closed);
    expect(await (await openSocket(secret, secretPass)).closure).toEqual(closed);
    await runInDurableObject(secretRoom, (_room, state) => {
      expect(state.storage.sql.exec("SELECT id FROM rolls").toArray()).toHaveLength(1);
    });
    expect((await other.list()).visited).toEqual([]);
    expect((await other.post(endpoint)).status).toBe(404);

    expect(await owner.list()).toMatchObject({
      owned: [],
      pendingDeletions: [{ id: board.id, title: board.title }],
    });
    const boardPage = await (await owner.fetch("/boards?lang=en")).text();
    expect(boardPage).toContain("Finish deleting");
    const polish = await (await owner.fetch("/boards?lang=pl")).text();
    expect(polish).toContain("Dokończ usuwanie");
    expect(boardPage).not.toContain(`/b/${board.shareCode}`);

    expect((await owner.post(endpoint)).status).toBe(204);
    expect(await Files.head(secretFile)).toBeNull();
    expect(await Files.head(thumbnail)).toBeNull();
    await runInDurableObject(secretRoom, (_room, state) => {
      expect(state.storage.sql.exec("SELECT id FROM rolls").toArray()).toEqual([]);
      expect(state.storage.kv.get("retired")).toBe(true);
    });
    expect(await owner.list()).not.toHaveProperty("pendingDeletions");
    expect((await owner.post(endpoint)).status).toBe(404);
  });
});
