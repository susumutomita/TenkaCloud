import { describe, expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  createGame,
  next,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { flowPositions } from "../../landing/cloud-master/motion.js";
import { buildShare } from "../../landing/cloud-master/share.js";
import { formatSurvival } from "../../landing/cloud-master/time.js";

const catalog = await loadCatalog();
const card = (uid: number, born = 0, height = 76) => ({
  uid,
  slot: uid,
  born,
  deadline: born + 12000,
  height,
});
describe("independent falling trajectories", () => {
  test("adding a new card never pushes or clamps an existing card", () => {
    const cache = new Map();
    const a = card(0);
    flowPositions([a], cache, 1200, 752, 1);
    const expected = flowPositions([a], new Map(cache), 1216, 752, 1)[0];
    const withArrival = flowPositions([a, card(1, 1216)], cache, 1216, 752, 1);
    expect(withArrival[0].y).toBe(expected.y);
    expect(withArrival[1].y + withArrival[1].height + 12).toBeLessThanOrEqual(withArrival[0].y);
    const frozen = flowPositions([a, card(1, 1216)], cache, 1216, 752, 1);
    expect(frozen.map((x) => x.y)).toEqual(withArrival.map((x) => x.y));
  });
  test("the leading card keeps moving at the bottom until its exact boundary", () => {
    const cache = new Map(),
      a = card(0);
    const before = flowPositions([a], cache, 11900, 752, 1)[0];
    const after = flowPositions([a], cache, 11950, 752, 1)[0];
    expect(after.y).toBeGreaterThan(before.y);
    expect(after.y + a.height).toBeLessThan(752);
    expect(flowPositions([a], cache, 12000, 752, 1)[0].y + a.height).toBe(752);
  });
  test("short-screen high-pressure normal cards reach the bottom and expire once with no stall", () => {
    const s = createGame(catalog, 12);
    s.elapsed = 600000;
    s.taughtLevel = LESSONS.length;
    s.pressureIndex = 10;
    s.maxCards = 3;
    s.outcomes = Array(10000).fill(false);
    start(s);
    const cache = new Map();
    let passes = 0;
    for (let i = 0; i < 1600; i++) {
      const old = [...s.active];
      const nearExpiry = old.filter((x) => x.deadline - s.elapsed <= 16);
      const projected = flowPositions(
        old.map((x) => ({ ...x, height: 130 })),
        new Map(cache),
        s.elapsed + 16,
        476,
        1,
      );
      for (const item of nearExpiry)
        expect(projected.find((x) => x.uid === item.uid).y + 130).toBeGreaterThanOrEqual(475);
      tick(s, 16);
      flowPositions(
        s.active.map((x) => ({ ...x, height: 130 })),
        cache,
        s.elapsed,
        476,
        1,
      );
      expect(s.phase).toBe("playing");
      passes = s.history.length;
    }
    expect(passes).toBeGreaterThan(10);
    expect(s.score).toBe(passes * 10);
    expect(new Set(s.history.map((x) => x.uid)).size).toBe(passes);
  });
  test("normal cards retain their physical deadline through pause and never cross the boundary", () => {
    const s = createGame(catalog, 0);
    s.maxCards = 1;
    start(s);
    const first = s.active[0];
    expect(first.question.danger).toBe(false);
    const cache = new Map();
    let lastY = 0;
    for (let i = 0; i < 1200 && s.active.some((x) => x.uid === first.uid); i++) {
      if (s.lessonNotice) showLesson(s);
      tickFrame(s, 16);
      if (s.active.some((x) => x.uid === first.uid)) {
        const row = flowPositions([{ ...first, height: 130 }], cache, s.elapsed, 476, 1)[0];
        expect(row.y).toBeGreaterThanOrEqual(lastY);
        expect(row.y + 130).toBeLessThan(476);
        lastY = row.y;
      }
      if (i === 820) {
        const before = { elapsed: s.elapsed, deadline: first.decisionDeadline };
        pause(s);
        tickFrame(s, 30000);
        resume(s);
        expect(s.elapsed).toBe(before.elapsed);
        expect(first.decisionDeadline).toBe(before.deadline);
      }
    }
    expect(first.decisionDeadline).toBeUndefined();
    expect(s.history.filter((h) => h.uid === first.uid)).toHaveLength(1);
    expect(s.score).toBe(10);
    tickFrame(s, 100);
    expect(s.history.filter((h) => h.uid === first.uid)).toHaveLength(1);
  });
  test("a missed card is removed once and never restored by continue", () => {
    const s = createGame(catalog, 1);
    s.maxCards = 1;
    start(s);
    const uid = s.active[0].uid;
    for (let i = 0; i < 1300 && s.phase !== "feedback"; i++) {
      if (s.lessonNotice) showLesson(s);
      tickFrame(s, 16);
    }
    expect(s.phase).toBe("feedback");
    expect(s.lives).toBe(2);
    expect(s.active.some((x) => x.uid === uid)).toBe(false);
    next(s);
    tickFrame(s, 850);
    expect(s.active.some((x) => x.uid === uid)).toBe(false);
    expect(s.history.filter((h) => h.uid === uid && h.kind === "miss")).toHaveLength(1);
    expect(s.lives).toBe(2);
  });
  test("resizing the field or translated card reprojects into the new visible range", () => {
    const cache = new Map(),
      a = card(0, 0, 130);
    flowPositions([a], cache, 10000, 752, 1);
    const small = flowPositions([a], cache, 10016, 476, 1)[0];
    expect(small.y + a.height).toBeLessThan(476);
    const taller = flowPositions([{ ...a, height: 170 }], cache, 10032, 476, 1)[0];
    expect(taller.y + 170).toBeLessThan(476);
  });
  test("optional stationary layout lays out unequal heights without overlap", () => {
    const rows = flowPositions(
      [card(0, 0, 130), card(1, 1, 76), card(2, 2, 114)],
      new Map(),
      6000,
      476,
      1,
      true,
    );
    expect(rows[1].y).toBeGreaterThanOrEqual(rows[0].y + 130 + 12);
    expect(rows[2].y).toBeGreaterThanOrEqual(rows[1].y + 76 + 12);
    expect(rows[2].y + 114).toBeLessThan(476);
  });
});
describe("one decimal survival time", () => {
  test("display floors to completed tenths and handles invalid or negative input", () => {
    for (const [input, expected] of [
      [0, "0.0秒"],
      [99, "0.0秒"],
      [100, "0.1秒"],
      [999, "0.9秒"],
      [1000, "1.0秒"],
      [59999, "59.9秒"],
      [60000, "60.0秒"],
      [123456, "123.4秒"],
      [-1, "0.0秒"],
      [Number.NaN, "0.0秒"],
      [Number.POSITIVE_INFINITY, "0.0秒"],
    ] as const)
      expect(formatSurvival(input)).toBe(expected);
  });
  test("sharing uses the same precision without adding a second time definition", () => {
    const s = createGame(catalog, 3);
    s.elapsed = 123456;
    expect(buildShare(s, { hostname: "localhost" }).text).toContain(
      `生存 ${formatSurvival(s.elapsed)}`,
    );
  });
});
