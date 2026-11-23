import { expect, type Page, test } from "@playwright/test";
import { createTLSchema } from "@tldraw/tlschema";
import { importPKCS8, SignJWT } from "jose";
import { mkdirSync, readFileSync } from "node:fs";

import { HOST, HOSTED, socketOf } from "../ports";
import { onBoard } from "./helpers";

// An assistant edits a board through the tabletop's MCP endpoint while a
// member has it open: the member sees the shapes arrive, and after a reload
// the board is the same, with no browser rewriting what the server wrote.
// The artifacts are the screenshots in SCREENSHOTS and the assertions.

const TABLETOP = HOSTED;
const SCREENSHOTS = process.env.OPS_SCREENSHOTS ?? "/home/user/ludamus/screenshots/board";

const key = importPKCS8(
  readFileSync(new URL("../../dev/dev-signing-key.pem", import.meta.url), "utf8"),
  "RS256",
);

async function sign(claims: Record<string, unknown>, audience: string) {
  const at = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setAudience(audience)
    .setIssuer("dev-host")
    .setSubject("u:assistant-test")
    .setIssuedAt(at)
    .setExpirationTime(at + 300)
    .sign(await key);
}

let rpcId = 0;

async function applyOps(board: string, ops: object[]) {
  const token = await sign({ boards: [{ access: "write", board, grant: 0 }] }, "tabletop-mcp");
  const meta = {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };
  const response = await fetch(`${TABLETOP}/mcp`, {
    body: JSON.stringify({
      id: ++rpcId,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { _meta: meta, arguments: { boardId: board, ops, runId: "e2e" }, name: "apply_ops" },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "apply_ops",
      "MCP-Protocol-Version": "2026-07-28",
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("data: ").at(-1)!);
  expect(body.result.isError).toBeUndefined();
  return JSON.parse(body.result.content[1].text) as { applied: number; errors: string[] };
}

type SyncRecord = Record<string, unknown> & { id: string; typeName: string };

// What the room holds, read the way a browser would: a sync socket's first
// answer is the whole document.
async function roomRecords(board: string): Promise<SyncRecord[]> {
  const pass = await sign(
    { board, link: 0, name: "Reader", owner: false, sub: "u:reader" },
    "board",
  );
  const socket = new WebSocket(
    `${socketOf(TABLETOP)}/rooms/${board}/connect?sessionId=${crypto.randomUUID()}&pass=${pass}`,
  );
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          connectRequestId: "reader",
          lastServerClock: 0,
          protocolVersion: 8,
          schema: createTLSchema().serialize(),
          type: "connect",
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      const messages = [JSON.parse(String(event.data))].flat();
      const connect = messages.find((message) => message.type === "connect");
      if (connect === undefined) return;
      socket.close();
      resolve(
        Object.values(connect.diff as Record<string, [string, SyncRecord]>).map(
          ([, record]) => record,
        ),
      );
    });
    socket.addEventListener("error", reject);
  });
}

const document = (records: SyncRecord[]) =>
  records
    .filter((record) => record.typeName === "shape" || record.typeName === "binding")
    .sort((a, b) => a.id.localeCompare(b.id));

// Every label tldraw draws inside a server-made shape fits in that shape:
// the growY the server computed is the one the browser's text needs.
async function expectLabelsInside(page: Page, ids: string[]) {
  for (const id of ids) {
    const shape = page.locator(`.tl-shape[data-shape-id="shape:${id}"]`);
    await expect(shape).toBeVisible();
    const outer = (await shape.boundingBox())!;
    const label = shape.locator(".tl-rich-text").first();
    const inner = (await label.boundingBox())!;
    expect(inner.y, `${id}: label top`).toBeGreaterThanOrEqual(outer.y - 1);
    expect(inner.y + inner.height, `${id}: label bottom`).toBeLessThanOrEqual(
      outer.y + outer.height + 1,
    );
    expect(inner.x + inner.width, `${id}: label right`).toBeLessThanOrEqual(
      outer.x + outer.width + 1,
    );
  }
}

test("an assistant's ops reach an open board live and survive a reload", async ({ page }) => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(`${HOST}/sign-in?name=Ada`);
  const bootstrap = page.waitForResponse((response) => response.url().includes("/bootstrap/"));
  await page.getByRole("button", { name: "New board" }).click();
  const answered = await bootstrap;
  const { board } = (await answered.json()) as { board: string };
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const result = await applyOps(board, [
    { at: { x: 80, y: 200 }, id: "tavern", kind: "box", op: "add", text: "The Yawning Portal" },
    { at: { x: 420, y: 180 }, h: 140, id: "well", kind: "box", op: "add", w: 140 },
    {
      id: "cellar",
      kind: "box",
      op: "add",
      relation: "right_of",
      target: "tavern",
      text: "Cellar",
    },
    {
      id: "rumour",
      kind: "note",
      op: "add",
      relation: "below",
      target: "tavern",
      text: "Plotka: w piwnicy ktoś widział smoka. Zażółć gęślą jaźń!",
    },
    {
      id: "quest",
      kind: "box",
      op: "add",
      relation: "right_of",
      target: "rumour",
      text: "Quest: find the missing brewer before the festival of the harvest moon begins",
      w: 220,
    },
    {
      id: "lair",
      kind: "ellipse",
      op: "add",
      relation: "below",
      target: "quest",
      text: "Dragon's lair",
    },
    { from: "tavern", op: "connect", text: "stairs", to: "cellar" },
    { from: "rumour", op: "connect", to: "quest" },
    { from: { text: "Quest" }, op: "connect", text: "two days", to: "lair" },
    { arrow: true, op: "label", target: "well", text: "Old well" },
    { op: "rename", target: "well", text: "Well" },
  ]);
  expect(result.errors).toEqual([]);

  // Live: the shapes arrive in the open tab without a reload.
  for (const text of ["The Yawning Portal", "Cellar", "Dragon's lair", "Old well", "two days"]) {
    await expect(onBoard(page, text)).toBeVisible();
  }
  await expectLabelsInside(page, ["tavern", "cellar", "rumour", "quest", "lair", "well"]);
  await page.screenshot({ path: `${SCREENSHOTS}/ops-live.png` });

  // The open tab changed nothing the server wrote: no reparenting or
  // re-indexing of the arrows, no re-measured growY.
  const written = document(await roomRecords(board));
  await page.reload();
  for (const text of ["The Yawning Portal", "Cellar", "Dragon's lair", "Old well", "two days"]) {
    await expect(onBoard(page, text)).toBeVisible();
  }
  await expectLabelsInside(page, ["tavern", "cellar", "rumour", "quest", "lair", "well"]);
  await page.waitForTimeout(1500);
  expect(document(await roomRecords(board))).toEqual(written);
  await page.screenshot({ path: `${SCREENSHOTS}/ops-reloaded.png` });
});
