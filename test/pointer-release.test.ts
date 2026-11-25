import { expect, it } from "vitest";

import { trackRelease } from "../client/src/pointer-release";

const point = (timeStamp: number, clientX: number, clientY = 0) => ({
  timeStamp,
  clientX,
  clientY,
});

it("uses the motion at release for a card placed at the same point", () => {
  const start = point(0, 0);
  const end = point(800, 200);
  const carried = trackRelease(start);
  carried.move(point(720, 180));
  expect(carried.isToss(end)).toBe(false);

  const flicked = trackRelease(start);
  flicked.move(point(750, 130));
  expect(flicked.isToss(end)).toBe(true);
});

it("recognizes a short flick after holding the card still", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(800, 3));
  hand.move(point(812, 16));
  expect(hand.isToss(point(820, 24))).toBe(true);
});

it("lets the hand come to rest after a fast drag", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(25, 120));
  expect(hand.isToss(point(106, 120))).toBe(false);
});

it("measures the last part of a sparsely sampled diagonal movement", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(200, 80, 80));
  expect(hand.isToss(point(240, 112, 112))).toBe(true);
});

it("ignores fingertip jitter and equal-timestamp events", () => {
  const hand = trackRelease(point(0, 40));
  hand.move(point(0, 42));
  expect(hand.isToss(point(0, 41))).toBe(false);
  expect(hand.isToss(point(3, 40))).toBe(false);
});
