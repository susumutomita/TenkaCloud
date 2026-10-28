import { expect, test } from "bun:test";
import { cutStyle } from "../../landing/cloud-master/paper-cut.js";

test("three paper cuts change the visible diagonal without using question RNG", () => {
  const cuts = [0, 1, 2].map((uid) => cutStyle(uid, 0, 360, 160));
  expect(new Set(cuts.map((c) => c.upper)).size).toBe(3);
  expect(cuts.map((c) => Math.sign(c.angle))).toEqual([1, -1, 0]);
  for (const cut of cuts) {
    expect(cut.upper.startsWith("polygon(0 0,100% 0,")).toBe(true);
    expect(cut.lower.endsWith("100% 100%,0 100%)")).toBe(true);
    expect(Number.isFinite(cut.angle)).toBe(true);
  }
  expect(cutStyle(0, 0, 360, 160)).toEqual(cutStyle(3, 0, 360, 160));
});
test("combo3/5/10 strengthen the cosmetic spread and cap it independently of score", () => {
  const levels = [0, 1, 2, 3, 4, 5, 9, 10, 20, 1000].map((combo) => cutStyle(0, combo, 360, 160));
  expect(levels.map((c) => c.strength)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3, 3]);
  expect(levels[0].spread).toBeLessThan(levels[3].spread);
  expect(levels[3].spread).toBeLessThan(levels[5].spread);
  expect(levels[5].spread).toBeLessThan(levels[7].spread);
  expect(levels[9].spread).toBe(39);
  expect(new Set(levels.map((c) => c.upper)).size).toBe(1);
});
