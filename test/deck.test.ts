import type { TLRecord } from "@tldraw/tlschema";

import { createShapeId, PageRecordType } from "@tldraw/tlschema";
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
    stored,
    command(payload: Record<string, unknown>) {
      const { action } = payload;
      const command = deckCommand.validate({
        ...(action === "flip" ? {} : { id: crypto.randomUUID() }),
        ...(action === "cancel" ? {} : { language: "en" }),
        page: page.id,
        ...(action === "draw" || action === "place" ? { point: { x: 200, y: 200 } } : {}),
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

  it("sets a hand-dropped card flat at its release point with the deck's orientation", () => {
    const { command, records } = table();
    const deck = placed(command(place));
    const stack = records.get(deck);
    if (stack?.typeName !== "shape") throw new Error("Stack is missing");
    records.set(deck, { ...stack, rotation: Math.PI / 2 });
    const id = crypto.randomUUID();
    const point = { x: 160, y: 130 };
    revealed(command({ ...draw(deck), id, point, precise: true }));
    const card = records.get(dealtCardId(deck, id));
    if (card?.typeName !== "shape" || card.type !== "image") throw new Error("Card is missing");
    expect(card.rotation).toBe(Math.PI / 2);
    expect(card.x - card.props.h / 2).toBeCloseTo(point.x);
    expect(card.y + card.props.w / 2).toBeCloseTo(point.y);
    expect(card.index > stack.index).toBe(true);
  });

  it("persists a fast release offset in the card's rotated local coordinates", () => {
    const { command, records } = table();
    const deck = placed(command(place));
    const stack = records.get(deck);
    if (stack?.typeName !== "shape") throw new Error("Stack is missing");
    records.set(deck, { ...stack, rotation: Math.PI / 2 });
    const id = crypto.randomUUID();
    const origin = { x: 160, y: 130 };
    const point = { x: 320, y: 240 };
    const drawn = {
      ...draw(deck),
      id,
      origin,
      point,
      precise: true,
      flight: { duration: 220 },
    };
    expect(command({ ...drawn, precise: false })).toBeNull();
    expect(command({ ...drawn, faceDown: true })).toBeNull();
    expect(() => command({ ...drawn, flight: { duration: 251 } })).toThrow();
    const result = revealed(command(drawn));
    const card = dealtCardId(deck, id);
    const landed = records.get(card);
    if (landed?.typeName !== "shape" || landed.type !== "image") throw new Error("Card is missing");
    expect(landed.x - landed.props.h / 2).toBeCloseTo(point.x);
    expect(landed.y + landed.props.w / 2).toBeCloseTo(point.y);
    expect(landed.meta.deckFlightDuration).toBe(220);
    expect(landed.meta.deckTravelX).toBeCloseTo(-110);
    expect(landed.meta.deckTravelY).toBeCloseTo(160);
    expect(revealed(command({ ...drawn, flight: { duration: 170 } }))).toBe(result);
    expect(records.get(card)).toBe(landed);
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 77 } });

    command({ action: "flip", card, faceDown: true });
    const reversed = records.get(card);
    if (reversed?.typeName !== "shape") throw new Error("Card is missing");
    expect(reversed.meta).not.toHaveProperty("deckFlightDuration");
  });

  it("reserves the exact top card without consuming it on cancellation", () => {
    const { command, records } = table();
    const deck = placed(command(place));
    const id = crypto.randomUUID();
    const prepare = { action: "prepare", deck, id };
    const prepared = command(prepare);
    expect(prepared).toHaveProperty("face");
    expect(command(prepare)).toEqual(prepared);
    expect(command({ action: "prepare", deck })).toBeNull();
    expect(command(draw(deck))).toBeNull();
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 78 } });

    expect(command({ action: "cancel", deck, id })).toEqual({ cancelled: true });
    expect(command(prepare)).toBeNull();
    const early = crypto.randomUUID();
    expect(command({ action: "cancel", deck, id: early })).toEqual({ cancelled: true });
    expect(command({ action: "prepare", deck, id: early })).toBeNull();
    expect(command({ ...draw(deck), prepared: true, id })).toBeNull();
    const next = crypto.randomUUID();
    expect(command({ action: "prepare", deck, id: next })).toEqual(prepared);
    const result = command({ ...draw(deck), prepared: true, id: next });
    expect(result).toHaveProperty("name");
    expect(command({ action: "prepare", deck, id: next })).toEqual(prepared);
    const dealt = records.get(dealtCardId(deck, next));
    expect(dealt).toMatchObject({
      meta: { deckFace: prepared && "face" in prepared ? prepared.face : "" },
    });
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 77 } });
  });

  it("keeps a long hold valid until another action steals its expired reservation", () => {
    const { command, stored } = table();
    const deck = placed(command(place));
    const id = crypto.randomUUID();
    const first = command({ action: "prepare", deck, id });
    const key = `gizmoDeck:${deck}`;
    function expire() {
      const state = stored.get(key);
      if (!state || !("reservation" in state) || !state.reservation) throw new Error("No pickup");
      stored.set(key, { ...state, reservation: { ...state.reservation, until: Date.now() - 1 } });
    }
    expire();
    expect(command({ ...draw(deck), id, prepared: true })).toHaveProperty("name");
    expect(command({ action: "prepare", deck, id })).toEqual(first);
    const stale = crypto.randomUUID();
    command({ action: "prepare", deck, id: stale });
    expire();
    expect(command({ action: "prepare", deck })).toHaveProperty("face");
    expect(command({ ...draw(deck), id: stale, prepared: true })).toBeNull();
  });

  it("persists only the back on the board until a retryable flip turns the prepared face", () => {
    const { command, records, stored } = table();
    const deck = placed(command(place));
    const id = crypto.randomUUID();
    const pickup = command({ action: "prepare", deck, id });
    if (!pickup || !("face" in pickup)) throw new Error("No prepared face");
    const drop = { ...draw(deck), id, prepared: true, faceDown: true, precise: true };
    const card = dealtCardId(deck, id);
    expect(command(drop)).toEqual({ card, faceDown: true });
    expect(command(drop)).toEqual({ card, faceDown: true });
    const before = records.get(card);
    if (before?.typeName !== "shape" || before.type !== "image" || !before.props.assetId)
      throw new Error("Face-down card is missing");
    const back = records.get(before.props.assetId);
    expect(back).toMatchObject({ props: { src: "/gizmos/tarot/art/back.webp" } });
    expect(before).toMatchObject({
      meta: { deckDown: true },
      props: { altText: "Face-down card" },
    });
    expect(before.meta).not.toHaveProperty("deckFace");
    expect(JSON.stringify([...records.values()])).not.toContain(pickup.face);
    expect(command({ action: "prepare", deck, id })).toEqual(pickup);

    records.delete(card);
    expect(stored.has(`gizmoDeckCard:${card}`)).toBe(true);
    expect(command({ action: "flip", card })).toBeNull();
    for (let discarded = 0; discarded < 17; discarded++) {
      const discardedId = crypto.randomUUID();
      const discardedCard = dealtCardId(deck, discardedId);
      expect(command({ ...draw(deck), id: discardedId, faceDown: true })).toEqual({
        card: discardedCard,
        faceDown: true,
      });
      records.delete(discardedCard);
    }
    expect(command(drop)).toEqual({ card, faceDown: true });
    records.set(card, { ...before, isLocked: true });
    expect(command({ action: "flip", card })).toBeNull();
    const group = createShapeId("locked-group");
    records.set(group, { ...before, id: group, type: "group", props: {}, isLocked: true });
    records.set(card, { ...before, parentId: group });
    expect(command({ action: "flip", card })).toBeNull();
    records.delete(group);
    records.set(card, before);
    const turned = command({ action: "flip", card });
    expect(turned).toHaveProperty("name");
    expect(command({ action: "flip", card, language: "pl" })).toEqual(turned);
    expect(records.get(card)).toMatchObject({
      x: before.x,
      y: before.y,
      rotation: before.rotation,
      meta: { deckFace: pickup.face },
      props: { w: before.props.w, h: before.props.h },
    });
    expect(command(drop)).toEqual({ card, faceDown: true });
    expect(command({ action: "prepare", deck, id })).toEqual(pickup);
    expect(stored.has(`gizmoDeckCard:${card}`)).toBe(true);
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 60 } });
  });

  it("turns a dealt face down and up without consuming another card or retriggering a retry", () => {
    const { command, records, stored } = table();
    const deck = placed(command(place));
    const id = crypto.randomUUID();
    const card = dealtCardId(deck, id);
    const result = command({ ...draw(deck), id, precise: true });
    const faceUp = records.get(card);
    if (faceUp?.typeName !== "shape" || faceUp.type !== "image") throw new Error("No dealt card");
    const face = faceUp.meta.deckFace;
    expect(face).toBeTruthy();
    const down = { action: "flip", card, faceDown: true };
    expect(command(down)).toEqual({ card, faceDown: true });
    const back = records.get(card);
    if (back?.typeName !== "shape" || back.type !== "image" || !back.props.assetId)
      throw new Error("No back");
    expect(records.get(back.props.assetId)).toMatchObject({
      props: { src: "/gizmos/tarot/art/back.webp" },
    });
    expect(back.meta).toMatchObject({ deckDown: true, deckTurnedAt: expect.any(Number) });
    expect(back.meta).not.toHaveProperty("deckFace");
    expect(back.meta).not.toHaveProperty("deckFaceId");
    expect(command(down)).toEqual({ card, faceDown: true });
    expect(records.get(card)).toBe(back);
    expect(command({ ...draw(deck), id, precise: true })).toEqual(result);
    expect(records.get(card)).toBe(back);

    const page = PageRecordType.create({
      id: PageRecordType.createId("other"),
      name: "Other",
      index: getIndexAbove(),
    });
    records.set(page.id, page);
    records.set(card, { ...back, parentId: page.id, x: 420, y: 260, rotation: Math.PI / 2 });
    for (const [key, value] of stored) stored.set(key, structuredClone(value));
    expect(command({ action: "flip", card })).toBeNull();
    expect(command({ action: "flip", card, page: page.id })).toEqual(result);
    const revealedCard = records.get(card);
    expect(revealedCard).toMatchObject({
      x: 420,
      y: 260,
      rotation: Math.PI / 2,
      parentId: page.id,
      props: { w: faceUp.props.w, h: faceUp.props.h },
      meta: { deckFace: face },
    });
    expect(command({ action: "flip", card, page: page.id, language: "pl" })).toEqual(result);
    expect(records.get(card)).toBe(revealedCard);
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 77 } });
  });

  it("turns legacy cards only when their canonical image matches the installed manifest", () => {
    const { command, records, stored } = table();
    const deck = placed(command(place));
    const id = crypto.randomUUID();
    const result = command({ ...draw(deck), id });
    const card = dealtCardId(deck, id);
    const current = records.get(card);
    if (current?.typeName !== "shape" || current.type !== "image")
      throw new Error("No legacy card");
    const { deckCardId: _card, deckFaceId: _face, ...legacyMeta } = current.meta;
    const legacy = { ...current, meta: legacyMeta };
    stored.delete(`gizmoDeckCard:${card}`);
    records.set(card, legacy);
    const copy = createShapeId("copy");
    records.set(copy, { ...legacy, id: copy });
    expect(command({ action: "flip", card: copy, faceDown: true })).toBeNull();
    records.set(card, { ...legacy, meta: { ...legacyMeta, deckFaceId: "fake-card" } });
    expect(command({ action: "flip", card, faceDown: true })).toBeNull();
    records.set(card, legacy);
    expect(command({ action: "flip", card, faceDown: true })).toEqual({ card, faceDown: true });
    expect(command({ action: "flip", card })).toEqual(result);
    expect(records.get(deck)).toMatchObject({ meta: { deckRemaining: 77 } });
  });

  it("places and draws a package pinned on the board with current owner access", async () => {
    const board = "deck-admission";
    const guest = await pass({ board, link: 1, sub: "g:guest" });
    const owner = await pass({ board, link: 1, owner: true });
    const stale = await pass({ board, owner: true });
    const staleGuest = await pass({ board, sub: "g:guest" });
    const wrongRoom = await pass({ board: "another-board", link: 1, sub: "g:guest" });
    const source = "https://github.com/test/gizmos/blob/" + "1".repeat(40) + "/deck/gizmo.json";
    function request(token: string, payload: Record<string, unknown>) {
      return call(`/rooms/${board}/deck`, token, {
        body: JSON.stringify({
          ...(payload.action === "flip" ? {} : { id: crypto.randomUUID() }),
          ...(payload.action === "cancel" ? {} : { language: "en" }),
          page: "page:page",
          ...(payload.action === "draw" || payload.action === "place"
            ? { point: { x: 200, y: 200 } }
            : {}),
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
    expect((await request(guest, { action: "prepare", deck })).status).toBe(403);
    const dealt = await request(owner, { ...draw(deck), language: "pl" });
    expect(dealt.status).toBe(200);
    expect(await dealt.json()).toEqual({ card: "moon", name: "Księżyc", width: 380 });
    const id = crypto.randomUUID();
    const pickup = await request(owner, { action: "prepare", deck, id });
    expect((await pickup.json<{ face: string }>()).face).toMatch(/\/front\.png$/u);
    expect(pickup.headers.get("Cache-Control")).toBe("no-store");
    const hidden = await request(owner, { ...draw(deck), id, prepared: true, faceDown: true });
    const card = dealtCardId(deck, id);
    expect(await hidden.json()).toEqual({ card, faceDown: true });
    const flip = { action: "flip", card, language: "pl" };
    expect((await request(staleGuest, flip)).status).toBe(403);
    expect((await request(wrongRoom, flip)).status).toBe(403);
    const turned = await request(guest, flip);
    expect(turned.status).toBe(200);
    expect(await turned.json()).toEqual({ card: "moon", name: "Księżyc", width: 380 });
    const back = await request(guest, { ...flip, faceDown: true });
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ card, faceDown: true });
    expect(await (await request(guest, flip)).json()).toEqual({
      card: "moon",
      name: "Księżyc",
      width: 380,
    });
  });
});
