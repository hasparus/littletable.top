import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

import { type ChatMessage, MAX_CHAT_MESSAGES_PER_MINUTE } from "../src/chat";
import { roomCall } from "./standalone-support";
import { pass, seat, until } from "./support";

// NOTE: A host may leave the address limiter unbound; chat must still have a limit.
const hostedEnv: Env = { ...(env as unknown as Env), Limiter: undefined };

const post = (board: string, token: string, body: string) =>
  roomCall(`/rooms/${board}/chat`, token, { body, method: "POST" }, hostedEnv);

describe("chat on a hosted board", () => {
  it("reaches everyone at the board and stays in its history", async () => {
    const board = "hosted-chat";
    const ania = await pass({ board });
    const bea = await pass({ board, name: "Bea", sub: "u:2" });
    const watcher = await seat(board, bea);

    const sent = await post(board, ania, "Ready?");
    expect(sent.status).toBe(200);
    const message: ChatMessage = await sent.json();
    expect(message).toMatchObject({ name: "Ania", sub: "u:1", text: "Ready?" });
    await until(() => watcher.received.some(({ type }) => type === "custom"));
    expect(watcher.received.find(({ type }) => type === "custom")?.data).toEqual({
      message,
      type: "chat",
    });
    const history = await roomCall(`/rooms/${board}/chat`, bea, {}, hostedEnv);
    expect(await history.json()).toEqual([message]);
  });

  it("limits each person's messages a minute", async () => {
    const board = "hosted-chat-limit";
    const ania = await pass({ board });
    for (let index = 0; index < MAX_CHAT_MESSAGES_PER_MINUTE; index++) {
      expect((await post(board, ania, `Message ${index}`)).status).toBe(200);
    }
    expect((await post(board, ania, "/roll 1d6")).status).toBe(429);
    const bea = await pass({ board, name: "Bea", sub: "u:2" });
    expect((await post(board, bea, "My turn")).status).toBe(200);
  });
});
