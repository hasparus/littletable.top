import type { TLRecord } from "@tldraw/tlschema";

import { PageRecordType } from "@tldraw/tlschema";
import { getIndexAbove } from "@tldraw/utils";
import { describe, expect, it } from "vitest";

import tarot from "../gizmos/tarot/gizmo.json";
import { changeDeck, dealtCardId, deckCommand, type DeckState } from "../src/deck";
import { type InstalledGizmo, normalizeManifest } from "../src/gizmo-packages";
import { call, pass } from "./support";

const pack: InstalledGizmo = {
  url: "https://github.com/example/gizmos/blob/1111111111111111111111111111111111111111/gizmos/tarot/gizmo.json",
  manifest: normalizeManifest(tarot, (path) => `/gizmos/tarot/${path}`),
};

function table() {
  const records = new Map<TLRecord["id"], TLRecord>();
  const stored = new Map<string, DeckState>();
  const page = PageRecordType.create({
    id: PageRecordType.createId("example"),
    index: getIndexAbove(),
    name: "Table",
  });
  records.set(page.id, page);
  return {
    records,
    command(payload: Record<string, unknown>) {
      const command = deckCommand.validate({
        id: crypto.randomUUID(),
        language: "en",
        page: page.id,
        point: { x: 200, y: 200 },
        ...payload,
      });
      return changeDeck(records, stored, (url) => (url === pack.url ? pack : null), command);
    },
  };
}

function placed(response: ReturnType<typeof changeDeck>) {
  expect(response).toHaveProperty("deck");
  if (response === null || !("deck" in response)) throw new Error("No deck was placed");
  return response.deck;
}

function revealed(response: ReturnType<typeof changeDeck>) {
  expect(response).toHaveProperty("name");
  if (response === null || !("name" in response)) throw new Error("No card was revealed");
  return response.name;
}

const place = { action: "place", install: pack.url, height: 148 };

function draw(deck: string) {
  return { action: "draw", deck, origin: { x: 200, y: 200 }, precise: false };
}

describe("installable physical decks", () => {
  it("uses every card in the pinned package once, then shuffles a fresh deck", () => {
    const { command, records } = table();
    const placement = crypto.randomUUID();
    const deck = placed(command({ ...place, id: placement }));
    expect(placed(command({ ...place, id: placement }))).toBe(deck);
    expect(records.get(deck)).toMatchObject({
      meta: { deckRemaining: tarot.cards.length },
      props: { altText: "Tarot deck" },
    });

    const id = crypto.randomUUID();
    const first = revealed(command({ ...draw(deck), id }));
    expect(revealed(command({ ...draw(deck), id }))).toBe(first);
    const names = [first];
    for (let count = 1; count < tarot.cards.length; count++) {
      names.push(revealed(command(draw(deck))));
    }
    expect(new Set(names)).toEqual(new Set(tarot.cards.map(({ name }) => name.en)));
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 0 } });
    expect(names).toContain(revealed(command(draw(deck))));
  });

  it("keeps two physical decks independent and checks the installed package", () => {
    const { command, records } = table();
    expect(command({ ...place, install: "uninstalled" })).toBeNull();
    const left = placed(command(place));
    const right = placed(command({ ...place, point: { x: 400, y: 200 } }));
    expect(left).not.toBe(right);

    const id = crypto.randomUUID();
    const translated = revealed(command({ ...draw(left), id, language: "pl" }));
    expect(tarot.cards.map(({ name }) => name.pl)).toContain(translated);
    const first = revealed(command({ ...draw(right), id }));
    const second = revealed(command(draw(right)));
    expect(first).not.toBe(second);
    expect(revealed(command({ ...draw(right), id }))).toBe(first);
    expect(records.get(left)).toMatchObject({ meta: { deckRemaining: 77 } });
    expect(records.get(right)).toMatchObject({ meta: { deckRemaining: 76 } });
  });

  it("fills a three-column grid in order and holds its spacing across taps and retries", () => {
    const { command, records } = table();
    const deck = placed(command(place));
    const grid = { x: 415, y: 200, columns: 3, stepX: 105, stepY: 160 };
    const placement = (id: string) => {
      const card = records.get(dealtCardId(deck, id));
      if (card?.typeName !== "shape" || card.type !== "image") throw new Error("Card is missing");
      return { x: card.x + card.props.w / 2, y: card.y + card.props.h / 2 };
    };
    const first = crypto.randomUUID();
    const expected = revealed(command({ ...draw(deck), id: first, grid }));
    const resizedView = { x: 900, y: 700, columns: 1, stepX: 200, stepY: 200 };
    expect(revealed(command({ ...draw(deck), id: first, grid: resizedView }))).toBe(expected);
    const otherIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    for (const id of otherIds) revealed(command({ ...draw(deck), id, grid: resizedView }));

    expect([first, ...otherIds].map(placement)).toEqual([
      { x: 415, y: 200 },
      { x: 520, y: 200 },
      { x: 625, y: 200 },
      { x: 415, y: 360 },
    ]);
  });

  it("keeps manually dealt cards in place and fills only free slots in a narrow grid", () => {
    const { command, records } = table();
    const deck = placed(command(place));
    const grid = { x: 415, y: 200, columns: 2, stepX: 105, stepY: 160 };
    const manualId = crypto.randomUUID();
    const manual = dealtCardId(deck, manualId);
    revealed(
      command({ ...draw(deck), id: manualId, point: { x: 419, y: 201 }, precise: true, grid }),
    );
    const before = records.get(manual);
    if (before?.typeName !== "shape" || before.type !== "image") throw new Error("Card is missing");
    expect(before.x + before.props.w / 2).toBe(419);
    expect(before.y + before.props.h / 2).toBe(201);

    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    revealed(command({ ...draw(deck), id: first, grid }));
    revealed(command({ ...draw(deck), id: second, grid }));
    expect(records.get(manual)).toBe(before);
    const later = [first, second].map((id) => {
      const card = records.get(dealtCardId(deck, id));
      if (card?.typeName !== "shape" || card.type !== "image") throw new Error("Card is missing");
      return { x: card.x + card.props.w / 2, y: card.y + card.props.h / 2 };
    });
    expect(later).toEqual([
      { x: 520, y: 200 },
      { x: 415, y: 360 },
    ]);
  });

  it("places and draws a package pinned on the board with current owner access", async () => {
    const board = "deck-admission";
    const guest = await pass({ board });
    const owner = await pass({ board, link: 1, owner: true });
    const stale = await pass({ board, owner: true });
    const source = "https://github.com/test/gizmos/blob/" + "1".repeat(40) + "/deck/gizmo.json";
    function request(token: string, payload: Record<string, unknown>) {
      return call(`/rooms/${board}/deck`, token, {
        body: JSON.stringify({
          id: crypto.randomUUID(),
          language: "en",
          page: "page:page",
          point: { x: 200, y: 200 },
          ...payload,
        }),
        method: "POST",
      });
    }
    const command = { ...place, install: source };
    expect((await request(guest, command)).status).toBe(403);
    expect((await request(owner, command)).status).toBe(409);
    expect(
      (
        await call(`/rooms/${board}/gizmos`, owner, {
          body: JSON.stringify({ url: source }),
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const response = await request(owner, command);
    expect(response.status).toBe(200);
    const { deck } = await response.json<{ deck: string }>();
    expect((await request(stale, draw(deck))).status).toBe(403);
    const dealt = await request(owner, { ...draw(deck), language: "pl" });
    expect(dealt.status).toBe(200);
    expect(await dealt.json()).toEqual({ card: "moon", name: "Księżyc", width: 380 });
  });
});
