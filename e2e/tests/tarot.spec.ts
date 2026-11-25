import { expect, test, type Locator, type Page } from "@playwright/test";

import { deckPrepared } from "../../src/deck-records";
import { STANDALONE } from "../ports";
import { joinAs } from "./helpers";

async function tapCard(page: Page, x: number, y: number, times = 1) {
  const finger = await page.context().newCDPSession(page);
  try {
    for (let tap = 0; tap < times; tap++) {
      await finger.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } finally {
    await finger.detach();
  }
}

type Point = { x: number; y: number };

async function cardCenter(card: Locator) {
  const box = (await card.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function expectCoast(release: Point, rest: Point, direction: Point) {
  const dx = rest.x - release.x;
  const dy = rest.y - release.y;
  const distance = Math.hypot(dx, dy);
  expect(distance).toBeGreaterThan(5);
  expect(distance).toBeLessThanOrEqual(155);
  const forward = (direction.x * dx + direction.y * dy) / Math.hypot(direction.x, direction.y);
  expect(forward).toBeGreaterThan(distance * 0.95);
}

type CardFrame = { x: number; angle: number };
type FlightSample = CardFrame & { tilt: number };

function cardAngle(card: Locator) {
  return card.evaluate((paper) => {
    const container = paper.closest("[data-shape-id]")!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(container).transform);
    return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  });
}

function expectTurn(start: number, end: number, direction: number) {
  const degrees = (end - start) * Math.sign(direction);
  expect(degrees).toBeGreaterThanOrEqual(0.98);
  expect(degrees).toBeLessThanOrEqual(2.02);
}

function expectTurningInFlight(
  frames: CardFrame[],
  releaseX: number,
  rest: CardFrame,
  initialAngle: number,
) {
  const progressed = frames.some(({ x, angle }) => {
    const travel = (x - releaseX) / (rest.x - releaseX);
    const turn = (angle - initialAngle) / (rest.angle - initialAngle);
    return travel > 0.05 && travel < 0.9 && turn > 0.05 && turn < 0.95;
  });
  expect(progressed).toBe(true);
}

function trackCardAfterRelease(page: Page, selector: string) {
  return page.evaluate(
    (selector) =>
      new Promise<FlightSample[]>((resolve) => {
        document.addEventListener(
          "pointerup",
          () => {
            const frames: FlightSample[] = [];
            const released = performance.now();
            function sample() {
              const paper = document.querySelector(selector);
              if (paper) {
                const box = paper.getBoundingClientRect();
                let angle = 0;
                for (let node: Element | null = paper; node; node = node.parentElement) {
                  if (
                    !node.matches(
                      "[data-shape-id], [data-deck-flight], [data-deck-loose-flight], [data-deck-ghost]",
                    )
                  )
                    continue;
                  const style = getComputedStyle(node);
                  if (style.transform !== "none") {
                    const matrix = new DOMMatrixReadOnly(style.transform);
                    angle += (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
                  }
                  if (style.rotate !== "none") angle += Number.parseFloat(style.rotate);
                }
                const back = paper.matches("[data-deck-waiting]")
                  ? paper
                  : paper.querySelector("img[data-deck-paper]");
                const transform = back && getComputedStyle(back).transform;
                const tilt =
                  transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m13 : 0;
                frames.push({ x: box.x + box.width / 2, angle, tilt });
              }
              if (performance.now() - released < 500) requestAnimationFrame(sample);
              else resolve(frames);
            }
            requestAnimationFrame(sample);
          },
          { once: true, capture: true },
        );
      }),
    selector,
  );
}

type PointerStep = { dx: number; dy: number; ms: number };

async function dragCard(
  page: Page,
  start: { x: number; y: number },
  steps: PointerStep[],
  releaseMs: number,
  onPickup?: () => Promise<void>,
) {
  const mouse = await page.context().newCDPSession(page);
  const startTime = (Date.now() - releaseMs) / 1000;
  let point = start;
  try {
    await mouse.send("Input.dispatchMouseEvent", {
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
      timestamp: startTime,
      type: "mousePressed",
    });
    await onPickup?.();
    for (const { dx, dy, ms } of steps) {
      point = { x: start.x + dx, y: start.y + dy };
      await mouse.send("Input.dispatchMouseEvent", {
        ...point,
        button: "left",
        buttons: 1,
        timestamp: startTime + ms / 1000,
        type: "mouseMoved",
      });
    }
    await mouse.send("Input.dispatchMouseEvent", {
      ...point,
      button: "left",
      clickCount: 1,
      timestamp: startTime + releaseMs / 1000,
      type: "mouseReleased",
    });
  } finally {
    await mouse.detach();
  }
}

async function openGallery(page: Page) {
  await page.getByTestId("main-menu.button").click();
  await expect(page.getByRole("menuitem", { name: "Tarot deck" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Gizmos", exact: true }).click();
  return page.getByRole("dialog", { name: "Gizmo gallery" });
}

test("a loose face-down card survives rejoining and reveals the face prepared at pickup", async ({
  browser,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ height: 760, width: 360 });
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Deck owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.emulateMedia({ reducedMotion: "reduce" });
  try {
    await guest.goto(page.url());
    await joinAs(guest, "Card player");
    await guest.getByTestId("main-menu.button").click();
    await expect(guest.getByRole("menuitem", { name: "Gizmos" })).toHaveCount(0);
    await guest.keyboard.press("Escape");

    await page.mouse.move(180, 255);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    const gallery = await openGallery(page);
    await expect(gallery).toBeInViewport({ ratio: 1 });
    await expect(gallery.getByText("Install your first Gizmo from GitHub.")).toBeVisible();
    const source = gallery.getByRole("textbox", { name: /GitHub/ });
    const upstream = "https://github.com/example/gizmos/blob/" + "a".repeat(40);
    for (const [name, folder] of [
      ["Tarot deck", "tarot"],
      ["Spotlight tracker", "spotlight"],
    ]) {
      await source.fill(upstream + "/gizmos/" + folder + "/gizmo.json");
      await gallery.getByRole("button", { name: "Install", exact: true }).click();
      await expect(gallery.getByRole("button", { name, exact: true })).toBeVisible();
    }
    const sounds = gallery.getByRole("button", { name: "Gizmo sounds" });
    await sounds.click();
    await expect(sounds).toHaveAttribute("aria-pressed", "false");
    const miniature = gallery.getByRole("button", { name: "Tarot deck" });
    const origin = await miniature.boundingBox();
    expect(origin).not.toBeNull();
    const finger = await page.context().newCDPSession(page);
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: origin!.x + origin!.width / 2, y: origin!.y + 48 }],
    });
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 105, y: 234 }],
    });
    await expect(page.locator("[data-gizmo-carry]")).toBeVisible();
    await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await finger.detach();
    await expect(gallery).toBeHidden();
    const stack = page.locator("[data-deck-stack]");
    await expect(stack).toBeVisible();
    const bounds = await stack.boundingBox();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - 105)).toBeLessThan(6);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - 234)).toBeLessThan(6);
    await expect(guest.locator("[data-deck-stack]")).toBeVisible();
    await expect(guest.getByRole("button", { name: "Draw a card" })).toHaveCount(0);

    const top = (await stack.getByRole("button", { name: "Draw a card" }).boundingBox())!;
    const center = { x: top.x + top.width / 2, y: top.y + top.height / 2 };
    const prepared = page.waitForResponse(
      (response) =>
        response.url().endsWith("/deck") &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().action === "prepare",
    );
    await dragCard(
      page,
      center,
      [
        { dx: 40, dy: 12, ms: 150 },
        { dx: 80, dy: 24, ms: 300 },
        { dx: 120, dy: 36, ms: 450 },
      ],
      480,
      async () => {
        const pickup = await prepared;
        expect(pickup.ok()).toBe(true);
        await expect(stack.locator("[data-deck-base]")).toHaveText("78");
      },
    );
    const pickup = await prepared;
    const { face } = deckPrepared.validate(await pickup.json());

    const loose = page.locator("[data-deck-down]");
    const guestBack = guest.locator("[data-deck-down]");
    await expect(loose).toHaveCount(1);
    await expect(guestBack).toBeVisible();
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");
    await guest.reload();
    await expect(guestBack).toBeVisible();
    await expect(guest.locator("[data-deck-front]")).toHaveCount(0);
    await page.reload();
    await expect(loose).toBeVisible();
    const ownerStart = await cardCenter(loose);
    const ownerBox = (await loose.boundingBox())!;
    const guestBox = (await guestBack.boundingBox())!;
    const guestStartAngle = await cardAngle(guestBack);
    const guestStart = { x: guestBox.x + guestBox.width / 2, y: guestBox.y + guestBox.height / 2 };
    await dragCard(
      guest,
      guestStart,
      [
        { dx: 2, dy: 20, ms: 20 },
        { dx: 8, dy: 75, ms: 40 },
      ],
      42,
    );
    const guestRest = await cardCenter(guestBack);
    const guestAngle = await cardAngle(guestBack);
    expectTurn(guestStartAngle, guestAngle, 75);
    expectCoast({ x: guestStart.x + 8, y: guestStart.y + 75 }, guestRest, { x: 8, y: 75 });
    const zoomRatio = ownerBox.width / guestBox.width;
    await expect
      .poll(async () => {
        const ownerRest = await cardCenter(loose);
        return ownerRest.y - ownerStart.y;
      })
      .toBeCloseTo((guestRest.y - guestStart.y) * zoomRatio, 0);
    await guest.reload();
    await expect(guestBack).toBeVisible();
    await expect.poll(() => cardCenter(guestBack)).toEqual(guestRest);
    await expect.poll(() => cardAngle(guestBack)).toBeCloseTo(guestAngle, 2);
    await expect.poll(() => cardAngle(loose)).toBeCloseTo(guestAngle, 2);
    await guestBack.getByRole("button", { name: "Turn card over" }).click();
    const guestFace = guest.locator("[data-deck-front]").getByRole("img", { name: /./u });
    await expect(guestFace).toHaveCount(1);
    await expect(guestFace).toHaveJSProperty("src", new URL(face, page.url()).href);
    await expect
      .poll(() => guestFace.evaluate((img: HTMLImageElement) => img.naturalHeight))
      .toBe(640);
    await expect(guestBack).toHaveCount(0);
    await expect(
      page.locator("[data-deck-front]").getByRole("img", { name: /./u }),
    ).toHaveJSProperty("src", new URL(face, page.url()).href);
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");

    const upButton = guest.getByRole("button", { name: "Turn card over" });
    const upBounds = (await upButton.boundingBox())!;
    await tapCard(guest, upBounds.x + upBounds.width / 2, upBounds.y + upBounds.height / 2);
    await expect(loose).toBeVisible();
    await expect(guestFace).toHaveCount(0);
    await loose.getByRole("button", { name: "Turn card over" }).click();
    await expect(guestFace).toHaveJSProperty("src", new URL(face, page.url()).href);
    await expect(guest.locator('[data-deck-front] img.tl-image[alt=""]')).toHaveCount(0);
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");

    await openGallery(page);
    await gallery.getByRole("button", { name: "Spotlight tracker" }).focus();
    await page.keyboard.press("Enter");
    await expect(gallery).toBeHidden();
    const next = page.locator("[data-tracker-seat]").first();
    await expect(next).toHaveAccessibleName("Mark a moment for Deck owner");
    await guest.keyboard.press("Escape");
    await guest.getByRole("button", { name: "Mark a moment for Deck owner" }).click();
    await expect(next).toHaveAccessibleName("Mark a moment for Card player");
  } finally {
    await guestContext.close();
  }
});

test("quick deals coast past the hand and loose cards slide without changing sides", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const top = page.getByRole("button", { name: "Draw a card" });
  const dealt = page.locator("[data-deck-card]");
  const count = page.locator("[data-deck-base]");
  await expect(count).toHaveText("78");
  const rect = (await top.boundingBox())!;
  const x = rect.x + 9,
    y = rect.y + 16;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 130, y - 74, { steps: 7 });
  const held = (await page.locator("[data-deck-ghost]").boundingBox())!;
  expect(Math.abs(held.x - rect.x - 130)).toBeLessThan(2);
  expect(Math.abs(held.y - rect.y + 74)).toBeLessThan(2);
  expect(Math.abs(held.width - rect.width)).toBeLessThan(2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(dealt).toHaveCount(0);
  await expect(count).toHaveText("78");

  const offset = rect.width * 0.35;
  const path = [
    { dx: 80, dy: -35, ms: 100 },
    { dx: 140, dy: -70, ms: 200 },
    { dx: offset, dy: 0, ms: 222 },
  ];
  await dragCard(page, { x, y }, path, 400);
  const down = page.locator("[data-deck-down]");
  await expect(down).toBeVisible();
  const near = (await down.boundingBox())!;
  expect(Math.abs(near.x - rect.x - offset)).toBeLessThan(2);
  expect(Math.abs(near.y - rect.y)).toBeLessThan(2);
  await expect(count).toHaveText("77");
  await expect(page.locator("[data-deck-front]")).toHaveCount(0);
  const center = { x: near.x + near.width / 2, y: near.y + near.height / 2 };
  const shift = { dx: 160, dy: 90 };
  await dragCard(
    page,
    center,
    [
      { dx: 48, dy: 28, ms: 140 },
      { dx: 100, dy: 60, ms: 300 },
      { ...shift, ms: 500 },
    ],
    530,
  );
  const parked = (await down.boundingBox())!;
  expect(await cardAngle(down)).toBeCloseTo(0, 2);
  expect(Math.abs(parked.x - near.x - shift.dx)).toBeLessThan(2);
  expect(Math.abs(parked.y - near.y - shift.dy)).toBeLessThan(2);
  await dragCard(page, { x, y }, path, 225);
  await expect(dealt).toHaveCount(1);
  await expect(dealt.locator("[data-deck-front] img")).toBeVisible();
  await expect(down).toHaveCount(1);
  await expect(count).toHaveText("76");

  const up = (await dealt.boundingBox())!;
  const dealtAngle = await cardAngle(dealt);
  expectTurn(0, dealtAngle, offset - 140);
  expectCoast(
    { x: rect.x + rect.width / 2 + offset, y: rect.y + rect.height / 2 },
    { x: up.x + up.width / 2, y: up.y + up.height / 2 },
    { x: offset - 140, y: 70 },
  );
  await dragCard(
    page,
    { x: up.x + up.width / 2, y: up.y + up.height / 2 },
    [
      { dx: 0, dy: 30, ms: 120 },
      { dx: 0, dy: 75, ms: 300 },
    ],
    315,
  );
  const shifted = (await dealt.boundingBox())!;
  expect(await cardAngle(dealt)).toBeCloseTo(dealtAngle, 2);
  expect(Math.abs(shifted.y - up.y - 75)).toBeLessThan(2);
  await expect(down).toHaveCount(1);

  const backCenter = await cardCenter(down);
  const frontCenter = await cardCenter(dealt);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const [card, selector, start, dx, dy] of [
    [down, "[data-deck-down]", backCenter, -80, -50],
    [dealt, "[data-deck-card]", frontCenter, 80, 20],
  ] as const) {
    const initialAngle = await cardAngle(card);
    const frames = trackCardAfterRelease(page, selector);
    await dragCard(
      page,
      start,
      [
        { dx: dx / 4, dy: dy / 4, ms: 20 },
        { dx, dy, ms: 40 },
      ],
      42,
    );
    await expect(down).toHaveCount(1);
    await expect(dealt).toHaveCount(1);
    const sampled = await frames;
    const release = { x: start.x + dx, y: start.y + dy };
    const rest = await cardCenter(card);
    expectCoast(release, rest, { x: dx, y: dy });
    const angle = await cardAngle(card);
    expectTurn(initialAngle, angle, dx);
    expectTurningInFlight(sampled, release.x, { x: rest.x, angle }, initialAngle);
  }
  await expect(count).toHaveText("76");
});

test("a card can be dragged immediately after turning it over", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Draw a card" }).click();
  const front = page.locator("[data-deck-card]");
  const back = page.locator("[data-deck-down]");
  const start = await cardCenter(front);
  await page.mouse.click(start.x, start.y);
  await expect(back).toBeVisible();
  await dragCard(page, start, [{ dx: 70, dy: 9, ms: 30 }], 180);
  const rest = await cardCenter(back);
  expect(Math.abs(rest.x - start.x - 70)).toBeLessThan(2);
  expect(Math.abs(rest.y - start.y - 9)).toBeLessThan(2);
});

test("rapid taps fill a three-column Tarot spread in reading order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  const top = page.getByRole("button", { name: "Draw a card" });
  const cards = page.locator("[data-deck-card]");
  const rect = (await top.boundingBox())!;
  await tapCard(page, rect.x + rect.width / 2, rect.y + rect.height / 2, 3);
  await expect(cards).toHaveCount(3);
  const centers = await cards.evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })
      .sort((a, b) => a.x - b.x),
  );
  expect(Math.abs(centers[2]!.y - centers[0]!.y)).toBeLessThan(1);
  expect(Math.abs(centers[2]!.x - 2 * centers[1]!.x + centers[0]!.x)).toBeLessThan(1);
  expect(centers[1]!.x - centers[0]!.x).toBeGreaterThan(70);
  for (const card of await cards.all()) await expect(card).toBeInViewport({ ratio: 0.99 });
  await top.click();
  await expect(cards).toHaveCount(4);
  await expect(page.locator("[data-deck-base]")).toHaveText("74");
});

test("a tossed back coasts while the artwork loads and settles at the same spot with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 720 });
  const faceArt = /\/gizmos\/tarot\/art\/(?!back\.webp)[^/]+\.webp$/;
  let fullMotionRest: (Point & { angle: number }) | undefined;

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.goto(STANDALONE + "/dev/gizmos");
    const top = page.locator("[data-deck-draw]");
    const card = page.locator("[data-deck-card]");
    const front = card.locator("[data-deck-front]");
    const allowArt = Promise.withResolvers<boolean>();
    await page.route(faceArt, async (route) => {
      await allowArt.promise;
      await route.continue();
    });
    const rect = (await top.boundingBox())!;
    const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const dx = rect.width * 1.8;
    const release = { x: start.x + dx, y: start.y + 35 };
    const requested = page.waitForRequest(faceArt);
    const frames = trackCardAfterRelease(page, "[data-deck-card], [data-deck-ghost]");
    const initialAngle = await cardAngle(top);
    let rest: Point & { angle: number };
    try {
      await dragCard(
        page,
        start,
        [
          { dx: rect.width, dy: 16, ms: 120 },
          { dx, dy: 35, ms: 145 },
        ],
        148,
        async () => {
          const request = await requested;
          expect(request.resourceType()).toBe("image");
          await expect(page.locator("[data-deck-base]")).toHaveText("78");
        },
      );
      const sampled = await frames;
      await expect(page.locator("[data-deck-card][data-deck-waiting]")).toHaveCount(1);
      await expect(card.locator("[data-deck-turn]")).toBeVisible();
      await expect(front).toBeHidden();
      await expect(page.locator("[data-deck-ghost], [data-deck-down]")).toHaveCount(0);
      rest = { ...(await cardCenter(card)), angle: await cardAngle(card) };
      expectTurn(initialAngle, rest.angle, dx);
      expectCoast(release, rest, { x: dx, y: 35 });
      if (reducedMotion === "no-preference") {
        expectTurningInFlight(sampled, release.x, rest, initialAngle);
        expect(sampled.some(({ tilt }) => Math.abs(tilt) > 0.4)).toBe(true);
        fullMotionRest = rest;
      } else {
        expect(sampled.every(({ tilt }) => Math.abs(tilt) < 0.01)).toBe(true);
        expect(rest.angle).toBeCloseTo(fullMotionRest!.angle, 2);
        expect(rest.x).toBeCloseTo(fullMotionRest!.x, 0);
        expect(rest.y).toBeCloseTo(fullMotionRest!.y, 0);
      }
    } finally {
      allowArt.resolve(true);
    }
    await expect(front).toBeVisible();
    expect(await cardAngle(card)).toBeCloseTo(rest.angle, 2);
    await expect(card).toHaveCount(1);
    const face = front.locator("img");
    const request = await requested;
    await expect(face).toHaveJSProperty("src", request.url());
    await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(640);
    await expect
      .poll(async () => {
        const settled = await cardCenter(card);
        return Math.hypot(settled.x - rest.x, settled.y - rest.y);
      })
      .toBeLessThan(1);
    await expect(page.locator("[data-deck-base]")).toHaveText("77");
    await page.unroute(faceArt);
  }
});
