import { expect, it } from "vitest";

import { cardTravel, trackRelease } from "../client/src/pointer-release";

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
  expect(carried.throwAt(end)).toBeNull();

  const flicked = trackRelease(start);
  flicked.move(point(750, 130));
  expect(flicked.throwAt(end)).not.toBeNull();
});

it("recognizes a short flick after holding the card still", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(800, 3));
  hand.move(point(812, 16));
  expect(hand.throwAt(point(820, 24))).not.toBeNull();
});

it("lets the hand come to rest after a fast drag", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(25, 120));
  expect(hand.throwAt(point(106, 120))).toBeNull();
});

it("measures the last part of a sparsely sampled diagonal movement", () => {
  const hand = trackRelease(point(0, 0));
  hand.move(point(200, 80, 80));
  expect(hand.throwAt(point(240, 112, 112))).not.toBeNull();
});

it("ignores fingertip jitter and equal-timestamp events", () => {
  const hand = trackRelease(point(0, 40));
  hand.move(point(0, 42));
  expect(hand.throwAt(point(0, 41))).toBeNull();
  expect(hand.throwAt(point(3, 40))).toBeNull();
});

it("coasts in the release direction, flying under gravity and slowing after contact", () => {
  const hand = trackRelease(point(0, 100, 100));
  const flight = hand.throwAt(point(40, 76, 132))!;
  // The established landing point for this diagonal flick is 82.03 px from release.
  expect(flight.x).toBeCloseTo(-49.22, 0);
  expect(flight.y).toBeCloseTo(65.63, 0);
});

it("lets a hard flick bleed off speed over its final 200 ms", () => {
  const flight = trackRelease(point(0, 0)).throwAt(point(20, 1000))!;
  expect(flight.x).toBeCloseTo(145.83, 0);
  expect(flight.y).toBe(0);
  expect(flight.duration).toBeGreaterThan(470);
  expect(flight.duration).toBeLessThan(500);

  const distanceAt = (ms: number) => cardTravel(0.72, ms);
  const late = distanceAt(400) - distanceAt(300);
  const last = flight.x - distanceAt(400);
  expect(late).toBeGreaterThan(7);
  expect(last).toBeGreaterThan(0.75);
  expect(last).toBeLessThan(late / 3);
  expect(flight.x - distanceAt(470)).toBeLessThan(0.05);
  expect(distanceAt(flight.duration + 100)).toBeCloseTo(flight.x);
});
