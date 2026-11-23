import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { Truth } from "../text-score";

import { HOST, HOSTED } from "../ports";
import {
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  openSheet,
  PHONE,
  sheet,
} from "./helpers";
import { fixture, sha256, uploadImage } from "./tldr";

// Text in images, end to end, against the hosted Worker and the real
// engines: Ada uploads a Polish character sheet and, on another page, a
// map whose labels run at angles; Bea, a guest who uploaded nothing, finds
// a label printed at −30° and the character's name, with and without
// diacritics and with a typo; choosing the label goes to its page and
// flashes the words, tilted as they are printed, over where the ground
// truth says they are; Cy, who joins once both are read, finds them
// without reading anything; deleting the map takes its text out of the
// results. No request leaves the tabletop and its host, and the page's
// policy is never broken. The artifacts are measurements.json (time to
// searchable, the worst frame gap on the uploader's board while both
// engines read, what the engines downloaded) and the screenshots.

const SHOTS = "/home/user/ludamus/screenshots/board";
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
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/ocr-${name}.png` });
}

const field = (page: Page) => page.getByRole("combobox", { name: "Search the board" });
const options = (page: Page) => page.getByRole("listbox", { name: "Results" }).getByRole("option");
const pageButton = (page: Page) => page.getByTestId("page-menu.button");
const reading = (page: Page) =>
  sheet(page, "Search")
    .getByRole("status")
    .filter({ hasText: /^Reading the text in/u });

// Every address a context asks for, and how many bytes came back.
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

// The longest wait between two frames from now on, on this page.
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
  // Ada is told why her map is not found yet, and only while it is so.
  await openSheet(ada.page, "Search");
  await expect(reading(ada.page)).toBeVisible();
  await shot(ada.page, "pending-desktop");

  // Bea finds the label printed at −30°, without diacritics, with a typo.
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

  // Once both are read, Ada's sheet says nothing more about it.
  await expect(reading(ada.page)).toHaveCount(0, { timeout: READ_MS });
  const frames = await worstFrame(ada.page);

  // Choosing the label goes to its page and flashes its words where the
  // map shows them, tilted with the print.
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
  // The outline's longest side runs along the print.
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

  // Cy joins once everything is read: found at once, nothing read again.
  const cy = await guest(browser, boardUrl, "Cy", DESKTOP);
  await openSheet(cy.page, "Search");
  await field(cy.page).fill("leczycki");
  await expect(options(cy.page).filter({ hasText: "Łęczycki" }).first()).toBeVisible();
  await field(cy.page).fill("sledziowa");
  await expect(options(cy.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible();
  await field(cy.page).fill("Kraśnik");
  await shot(cy.page, "results-desktop");
  expect(cy.network.engineFiles()).toEqual([]);

  // Deleting the map takes its text out of everyone's results.
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
  // Bea is told the map is being read; Ada's browser holds it.
  await expect(reading(bea.page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => ada.network.engineFiles().length, { timeout: 30_000 }).toBeGreaterThan(0);
  const left = Date.now();
  await ada.page.context().close();

  await field(bea.page).fill("sledziowa");
  await expect(options(bea.page).filter({ hasText: "Śledziowa" }).first()).toBeVisible({
    timeout: 150_000,
  });
  // Bea's own browser read it: it fetched the engines, after the lease ran out.
  expect(bea.network.engineFiles().length).toBeGreaterThan(0);
  expect(Date.now() - left).toBeGreaterThan(25_000);
  await expectNoCspViolations(bea.page);
  await bea.page.context().close();
});
