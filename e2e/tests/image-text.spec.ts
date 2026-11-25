import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

import type { Truth } from "../text-score";

import { HOST, HOSTED } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  openSheet,
  PHONE,
  putNote,
  reachEditor,
  reviewShot,
  sheet,
} from "./helpers";
import { fixture, sha256, uploadImage } from "./tldr";

const DESKTOP = { ...devices["Desktop Chrome"], deviceScaleFactor: 2 };
const PHONE_2X = { ...PHONE, deviceScaleFactor: 2 };

const MAP = "text/map_pl.jpg";
const SHEET = "text/sheet_pl_scan.jpg";
const MAP_HASH = sha256(readFileSync(fixture(MAP)));
const truth = JSON.parse(readFileSync(fixture("text/map_pl.gt.json"), "utf8")) as Truth;
// Long enough for a cold start: both engines' files, then both images.
const READ_MS = 150_000;

async function shot(page: Page, name: string): Promise<void> {
  if (test.info().project.name !== "chromium") return;
  await reviewShot(page, `ocr-${name}`);
}

const field = (page: Page) => page.getByRole("combobox", { name: "Search the board" });
const options = (page: Page) => page.getByRole("listbox", { name: "Results" }).getByRole("option");
const pageButton = (page: Page) => page.getByTestId("page-menu.button");
const reading = (page: Page) =>
  sheet(page, "Search")
    .getByRole("status")
    .filter({ hasText: /^Reading the text in/u });

function watch(context: BrowserContext) {
  const seen: { bytes: number; url: string }[] = [];
  context.on("requestfinished", async (request) => {
    const sizes = await request.sizes().catch(() => null);
    seen.push({ bytes: sizes?.responseBodySize ?? 0, url: request.url() });
  });
  context.on("requestfailed", (request) => seen.push({ bytes: 0, url: request.url() }));
  return {
    engineBytes: () =>
      seen
        .filter(({ url }) => /\/assets\/(ocr\/|ort-wasm|text-worker)/u.test(url))
        .reduce((sum, { bytes }) => sum + bytes, 0),
    engineFiles: () =>
      seen.filter(({ url }) => /\/assets\/(ocr\/|ort-wasm|text-worker)/u.test(url)),
    offOrigin: () =>
      seen.filter(
        ({ url }) =>
          !url.startsWith(HOSTED) && !url.startsWith(HOST) && !/^(blob|data):/u.test(url),
      ),
  };
}

async function member(browser: Browser, name: string) {
  const context = await browser.newContext(DESKTOP);
  const network = watch(context);
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=${name}`);
  return { network, page };
}

async function guest(browser: Browser, url: string, name: string, device: object) {
  const context = await browser.newContext(device);
  const network = watch(context);
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(url);
  await joinAs(page, name);
  return { network, page };
}

async function addPage(page: Page, name: string): Promise<void> {
  await pageButton(page).click();
  await page.getByTestId("page-menu.create").click();
  const named = page.getByTestId("page-menu.list").getByRole("textbox");
  await named.fill(name);
  await named.press("Enter");
  await expect(pageButton(page)).toHaveText(name);
  await page.keyboard.press("Escape");
}

const trackFrames = (page: Page) =>
  page.evaluate(() => {
    const state = { last: performance.now(), worst: 0 };
    (globalThis as unknown as { __frames: typeof state }).__frames = state;
    const tick = (now: number) => {
      state.worst = Math.max(state.worst, now - state.last);
      state.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const worstFrame = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __frames: { worst: number } }).__frames.worst);

// Where the flash is on screen, and where the ground truth puts a word of
// the map's image as the board shows it now (unrotated, uncropped).
async function flashAndTruth(page: Page, word: string) {
  const flash = page.getByRole("img", { name: /^Found: /u });
  const points = await flash.evaluate((svg) => {
    const { left, top } = svg.getBoundingClientRect();
    const polygon = svg.querySelector("polygon")!;
    return [...polygon.points].map((point) => ({ x: point.x + left, y: point.y + top }));
  });
  const image = await page
    .getByTestId("canvas")
    .locator(`img.tl-image[src$="${MAP_HASH}"]`)
    .evaluate((img) => {
      const { height, left, top, width } = img.getBoundingClientRect();
      return { height, left, top, width };
    });
  const [x0, y0, x1, y1] = truth.words.find((each) => each.text === word)!.bbox as number[];
  const k = image.width / truth.width;
  const label = {
    x0: image.left + x0! * k,
    x1: image.left + x1! * k,
    y0: image.top + y0! * k,
    y1: image.top + y1! * k,
  };
  return { label, points };
}

test("text one person's images carry is found by others, there and tilted", async ({ browser }) => {
  test.setTimeout(420_000);
  const ada = await member(browser, "Ada");
  await ada.page.getByRole("button", { name: "New board" }).click();
  await expect(ada.page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const boardUrl = ada.page.url();
  const bea = await guest(browser, boardUrl, "Bea", PHONE_2X);

  await trackFrames(ada.page);
  const uploaded = Date.now();
  await uploadImage(ada.page, SHEET);
  await addPage(ada.page, "Mapa");
  await uploadImage(ada.page, MAP);
  await openSheet(ada.page, "Search");
  await expect(reading(ada.page)).toBeVisible();
  await shot(ada.page, "pending-desktop");

  const search = await openSheet(bea.page, "Search");
  for (const query of ["Śledziowa", "sledziowa", "Sledzowa"]) {
    await field(bea.page).fill(query);
    await expect(options(bea.page).filter({ hasText: "Zatoka Śledziowa" }).first()).toContainText(
      "In image",
      { timeout: query === "Śledziowa" ? READ_MS : 10_000 },
    );
  }
  const searchable = Date.now() - uploaded;
  for (const query of ["Łęczycki", "leczycki", "Łęczyki"]) {
    await field(bea.page).fill(query);
    await expect(options(bea.page).filter({ hasText: "Łęczycki" }).first()).toContainText(
      "Page 1",
      {
        timeout: READ_MS,
      },
    );
  }
  await shot(bea.page, "results-phone");

  await expect(reading(ada.page)).toHaveCount(0, { timeout: READ_MS });
  const frames = await worstFrame(ada.page);

  await field(bea.page).fill("Zatoka Śledziowa");
  await options(bea.page).filter({ hasText: "Zatoka Śledziowa" }).first().tap();
  await expect(search).toBeHidden();
  await expect(pageButton(bea.page)).toHaveText("Mapa");
  await expect(bea.page.getByRole("img", { name: /^Found: .*Zatoka Śledziowa/u })).toBeVisible();
  const { label, points } = await flashAndTruth(bea.page, "Śledziowa");
  const box = {
    x0: Math.min(...points.map((p) => p.x)),
    x1: Math.max(...points.map((p) => p.x)),
    y0: Math.min(...points.map((p) => p.y)),
    y1: Math.max(...points.map((p) => p.y)),
  };
  const covered =
    (Math.max(0, Math.min(box.x1, label.x1) - Math.max(box.x0, label.x0)) *
      Math.max(0, Math.min(box.y1, label.y1) - Math.max(box.y0, label.y0))) /
    ((label.x1 - label.x0) * (label.y1 - label.y0));
  expect(covered).toBeGreaterThan(0.5);
  const sides = points.map((from, at) => {
    const to = points[(at + 1) % points.length]!;
    return {
      angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      length: Math.hypot(to.x - from.x, to.y - from.y),
    };
  });
  const along = sides.toSorted((a, b) => b.length - a.length)[0]!.angle;
  const tilt = ((along % 180) + 180) % 180;
  expect(Math.abs(tilt - 30) < 10 || Math.abs(tilt - 150) < 10, `tilted ${along}°`).toBe(true);
  await shot(bea.page, "flash-rotated-phone");

  const cy = await guest(browser, boardUrl, "Cy", DESKTOP);
  await openSheet(cy.page, "Search");
  await field(cy.page).fill("leczycki");
  await expect(options(cy.page).filter({ hasText: "Łęczycki" }).first()).toBeVisible();
  await field(cy.page).fill("sledziowa");
  await expect(options(cy.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible();
  await field(cy.page).fill("Kraśnik");
  await shot(cy.page, "results-desktop");
  expect(cy.network.engineFiles()).toEqual([]);

  await bea.page
    .getByTestId("canvas")
    .locator(`img.tl-image[src$="${MAP_HASH}"]`)
    .click({ force: true });
  await bea.page.keyboard.press("Delete");
  await field(cy.page).fill("sledziowa");
  await expect(
    sheet(cy.page, "Search")
      .getByRole("status")
      .filter({ hasText: "Nothing on the board matches “sledziowa”." }),
  ).toBeVisible();

  for (const each of [ada, bea, cy]) {
    expect(each.network.offOrigin()).toEqual([]);
    await expectNoCspViolations(each.page);
  }
  writeFileSync(
    test.info().outputPath("measurements.json"),
    JSON.stringify(
      {
        engineDownloadBytes: ada.network.engineBytes(),
        engineFiles: ada.network.engineFiles(),
        msUntilSearchable: searchable,
        worstFrameGapMs: frames,
      },
      null,
      2,
    ),
  );
  for (const each of [ada, bea, cy]) await each.page.context().close();
});

test("when the uploader leaves mid-read, another browser reads the image once the lease runs out", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ada = await member(browser, "Ada");
  await ada.page.getByRole("button", { name: "New board" }).click();
  await expect(ada.page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const bea = await guest(browser, ada.page.url(), "Bea", DESKTOP);
  await openSheet(bea.page, "Search");

  await uploadImage(ada.page, MAP);
  await expect(reading(bea.page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => ada.network.engineFiles().length, { timeout: 30_000 }).toBeGreaterThan(0);
  let claims = 0;
  bea.page.on("request", (request) => {
    if (request.url().endsWith("/files/text/claim")) claims++;
  });
  const left = Date.now();
  await ada.page.context().close();

  await closeSheet(bea.page, "Search");
  for (const [at, text] of [
    [200, "Port"],
    [500, "Las"],
    [800, "Wieża"],
  ] as const) {
    await putNote(bea.page, { at: { x: at, y: 500 }, text });
    // WARNING: Pause past the 4 s input cooldown so a missing lease guard would trigger a claim.
    await bea.page.waitForTimeout(5000);
  }
  await bea.page.waitForTimeout(Math.max(0, left + 25_000 - Date.now()));
  expect(claims, "claims while someone else's lease lapses").toBeLessThanOrEqual(1);
  await openSheet(bea.page, "Search");

  await field(bea.page).fill("sledziowa");
  await expect(options(bea.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible({
    timeout: 150_000,
  });
  expect(bea.network.engineFiles().length).toBeGreaterThan(0);
  expect(Date.now() - left).toBeGreaterThan(25_000);
  await expectNoCspViolations(bea.page);
  await bea.page.context().close();
});

type ImageShape = {
  id: string;
  props: { crop: unknown; flipX: boolean; h: number; w: number };
  rotation: number;
};
type Editor = {
  flipShapes: (ids: string[], direction: "horizontal" | "vertical") => void;
  getAsset: (id: string) => { props: { src: string } } | undefined;
  getCurrentPageShapes: () => (ImageShape & { props: { assetId: string }; type: string })[];
  updateShape: (partial: object) => void;
};

const mapShape = (page: Page) =>
  page.evaluate((hash) => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    const shape = editor
      .getCurrentPageShapes()
      .find(
        (each) =>
          each.type === "image" && editor.getAsset(each.props.assetId)?.props.src.endsWith(hash),
      )!;
    return { id: shape.id, props: shape.props, rotation: shape.rotation };
  }, MAP_HASH);

// Turns, resizes and crops the map at once: `crop` is the part of the
// image as displayed that stays, the uncropped image is `scale` of its
// source size.
const cropMap = (
  page: Page,
  change: { crop: [number, number, number, number]; rotation: number; scale: number },
) =>
  page.evaluate(
    ({ change, hash, size }) => {
      const editor = (globalThis as unknown as { __editor: Editor }).__editor;
      const shape = editor
        .getCurrentPageShapes()
        .find(
          (each) =>
            each.type === "image" && editor.getAsset(each.props.assetId)?.props.src.endsWith(hash),
        )!;
      const [x0, y0, x1, y1] = change.crop;
      editor.updateShape({
        id: shape.id,
        props: {
          crop: { bottomRight: { x: x1, y: y1 }, topLeft: { x: x0, y: y0 } },
          h: size.h * change.scale * (y1 - y0),
          w: size.w * change.scale * (x1 - x0),
        },
        rotation: change.rotation,
        type: "image",
      });
    },
    { change, hash: MAP_HASH, size: { h: truth.height, w: truth.width } },
  );

// Where pixels of the map's source land on screen, as the browser draws
// the <img>: a marker per pixel, inside a box that copies the image's own
// box and flip, so it goes through tldraw's crop, flip, shape and camera
// transforms exactly as the picture does.
const onScreen = (page: Page, pixels: { x: number; y: number }[], hash = MAP_HASH) =>
  page
    .getByTestId("canvas")
    .locator(`img.tl-image[src$="${hash}"]`)
    .evaluate(
      (img: HTMLImageElement, { pixels, size }) => {
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;inset:0;transform:${img.style.transform};transform-origin:${img.style.transformOrigin || "center center"}`;
        img.parentElement!.append(box);
        const points = pixels.map(({ x, y }) => {
          const marker = document.createElement("div");
          marker.style.cssText = `position:absolute;left:${(x / size.w) * 100}%;top:${(y / size.h) * 100}%;width:0;height:0`;
          box.append(marker);
          const { left, top } = marker.getBoundingClientRect();
          return { x: left, y: top };
        });
        box.remove();
        return points;
      },
      { pixels, size: { h: truth.height, w: truth.width } },
    );

const flashPointsNow = (page: Page) =>
  page.getByRole("img", { name: /^Found: /u }).evaluate((svg) => {
    const { left, top } = svg.getBoundingClientRect();
    const polygon = svg.querySelector("polygon")!;
    return [...polygon.points].map((point) => ({ x: point.x + left, y: point.y + top }));
  });

type Point = { x: number; y: number };

// WARNING: Wait for the camera to settle before comparing screen coordinates.
async function flashPoints(page: Page): Promise<Point[]> {
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await flashPointsNow(page));
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return JSON.parse(last) as Point[];
}

// Whether `point` is inside the convex polygon, whichever way it winds.
function inside(point: Point, polygon: Point[]): boolean {
  const sides = polygon.map((from, at) => {
    const to = polygon[(at + 1) % polygon.length]!;
    return Math.sign((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
  });
  return sides.every((side) => side >= 0) || sides.every((side) => side <= 0);
}

const centre = (points: Point[]): Point => ({
  x: points.reduce((sum, { x }) => sum + x, 0) / points.length,
  y: points.reduce((sum, { y }) => sum + y, 0) / points.length,
});

// The angle on screen of the polygon's longest side, folded into [0, 180).
function longestSideAngle(points: Point[]): number {
  const sides = points.map((from, at) => {
    const to = points[(at + 1) % points.length]!;
    return {
      angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      length: Math.hypot(to.x - from.x, to.y - from.y),
    };
  });
  const { angle } = sides.toSorted((a, b) => b.length - a.length)[0]!;
  return ((angle % 180) + 180) % 180;
}

const folded = (degrees: number) => ((degrees % 180) + 180) % 180;
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));

async function expectFlashOnLabel(bea: Page, hash = MAP_HASH): Promise<void> {
  await openSheet(bea, "Search");
  await field(bea).fill("Śledziowa");
  await options(bea).filter({ hasText: "Śledziowa" }).first().click();
  await expect(bea.getByRole("img", { name: /^Found: .*Śledziowa/u })).toBeVisible();
  const word = truth.words.find((each) => each.text === "Śledziowa")!;
  const [x0, y0, x1, y1] = word.bbox as [number, number, number, number];
  const middle = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const radians = (word.angle * Math.PI) / 180;
  const along = { x: middle.x + 40 * Math.cos(radians), y: middle.y - 40 * Math.sin(radians) };
  const points = await flashPoints(bea);
  const [labelMiddle, labelAlong, ...corners] = await onScreen(
    bea,
    [middle, along, { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    hash,
  );
  expect(inside(labelMiddle!, points), "the word's middle is inside the flash").toBe(true);
  expect(inside(centre(points), corners), "the flash's middle is on the word").toBe(true);
  const printed = folded(
    (Math.atan2(labelAlong!.y - labelMiddle!.y, labelAlong!.x - labelMiddle!.x) * 180) / Math.PI,
  );
  const drawn = longestSideAngle(points);
  expect(apart(drawn, printed), `flash at ${drawn}°, print at ${printed}°`).toBeLessThan(10);
}

test("a label is found where an image shows it after it is turned, resized, cropped and flipped", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ada = await member(browser, "Ada");
  await ada.page.getByRole("button", { name: "New board" }).click();
  await expect(ada.page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const bea = await guest(browser, ada.page.url(), "Bea", DESKTOP);
  await uploadImage(ada.page, MAP);
  await openSheet(bea.page, "Search");
  await field(bea.page).fill("Śledziowa");
  await expect(options(bea.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible({
    timeout: READ_MS,
  });
  await closeSheet(bea.page, "Search");
  for (const each of [ada, bea]) await reachEditor(each.page);

  await cropMap(ada.page, { crop: [0.35, 0.6, 0.8, 1], rotation: 0.5, scale: 0.6 });
  await expect.poll(() => mapShape(bea.page).then((shape) => shape.rotation)).toBe(0.5);
  await expectFlashOnLabel(bea.page);
  await shot(bea.page, "flash-cropped-desktop");

  // Flipped as the menu flips it, which mirrors the crop with the image.
  const { id } = await mapShape(ada.page);
  await ada.page.evaluate((shape) => {
    (globalThis as unknown as { __editor: Editor }).__editor.flipShapes([shape], "horizontal");
  }, id);
  await expect.poll(() => mapShape(bea.page).then((shape) => shape.props.flipX)).toBe(true);
  await expectFlashOnLabel(bea.page);
  await shot(bea.page, "flash-flipped-desktop");

  await cropMap(ada.page, { crop: [0, 0, 0.3, 0.3], rotation: 0.5, scale: 0.6 });
  await expect
    .poll(() => mapShape(bea.page).then((shape) => JSON.stringify(shape.props.crop)))
    .toContain('"bottomRight":{"x":0.3');
  await openSheet(bea.page, "Search");
  await field(bea.page).fill("Śledziowa");
  await options(bea.page).filter({ hasText: "Śledziowa" }).first().click();
  await expect(
    bea.page.getByRole("img", { name: /^Found: .*Śledziowa.*\. Hidden by the image's crop$/u }),
  ).toBeVisible();
  const outline = await flashPoints(bea.page);
  const corners = await bea.page
    .getByTestId("canvas")
    .locator(`img.tl-image[src$="${MAP_HASH}"]`)
    .evaluate((img) => {
      const { height, left, top, width } =
        img.parentElement!.parentElement!.getBoundingClientRect();
      return { height, left, top, width };
    });
  const flashMiddle = centre(outline);
  expect(Math.abs(flashMiddle.x - (corners.left + corners.width / 2))).toBeLessThan(4);
  expect(Math.abs(flashMiddle.y - (corners.top + corners.height / 2))).toBeLessThan(4);
  await shot(bea.page, "flash-hidden-desktop");
  for (const each of [ada, bea]) await each.page.context().close();
});

// map_pl_sideways.jpg is map_pl.jpg with its pixels turned a quarter to
// the left and EXIF orientation 6, as a phone held upright writes a photo:
// shown upright, stored sideways, and small enough not to be redrawn.
const SIDEWAYS = "text/map_pl_sideways.jpg";

test("a sideways photo's text is found where the board shows it upright", async ({ browser }) => {
  test.setTimeout(300_000);
  const ada = await member(browser, "Ada");
  await ada.page.getByRole("button", { name: "New board" }).click();
  await expect(ada.page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const bea = await guest(browser, ada.page.url(), "Bea", DESKTOP);
  await uploadImage(ada.page, SIDEWAYS);
  await openSheet(bea.page, "Search");
  await field(bea.page).fill("Śledziowa");
  await expect(options(bea.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible({
    timeout: READ_MS,
  });
  await closeSheet(bea.page, "Search");
  await expectFlashOnLabel(bea.page, sha256(readFileSync(fixture(SIDEWAYS))));
  await shot(bea.page, "flash-sideways-desktop");
  for (const each of [ada, bea]) {
    await expectNoCspViolations(each.page);
    await each.page.context().close();
  }
});
