import { describe, expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  next,
  REVIEW_DECISION_MS,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";

const catalog = await loadCatalog();
function batch(danger: boolean) {
  const s = createGame(catalog, 3);
  s.elapsed = 300000;
  s.taughtLevel = LESSONS.length;
  s.pressureIndex = 10;
  s.outcomes = Array(20).fill(danger);
  start(s);
  tick(s, 3800);
  return s;
}
describe("one confirmed mistake costs exactly one life", () => {
  test("first normal mistake pauses at2lives; compatibility/stale and othercard events cannot consume more", () => {
    const s = batch(false),
      item = s.active[0],
      other = s.active[1];
    expect(collect(s, item.uid)).toBe(true);
    expect(s.lives).toBe(2);
    expect(s.phase).toBe("feedback");
    expect(s.mistakes).toBe(1);
    for (let i = 0; i < 10; i++) {
      expect(collect(s, item.uid)).toBe(false);
      expect(collect(s, other.uid)).toBe(false);
      tickFrame(s, 5000);
    }
    expect(s.lives).toBe(2);
    expect(s.history).toHaveLength(1);
    expect(s.score).toBe(0);
  });
  test("normal mistakes require3distinctIDs and acknowledgment between3→2→1→0", () => {
    const s = batch(false),
      ids = s.active.slice(0, 3).map((x) => x.uid);
    for (const [i, uid] of ids.entries()) {
      expect(collect(s, uid)).toBe(true);
      expect(s.lives).toBe(2 - i);
      expect(s.phase).toBe("feedback");
      expect(s.history.filter((x) => x.uid === uid)).toHaveLength(1);
      const at = s.elapsed;
      tick(s, 100000);
      expect(s.elapsed).toBe(at);
      expect(s.lives).toBe(2 - i);
      next(s);
      expect(collect(s, uid)).toBe(false);
    }
    expect(s.phase).toBe("finished");
    expect(s.mistakes).toBe(3);
    expect(s.history.map((x) => x.uid)).toEqual(ids);
    const fresh = createGame(catalog, 3);
    start(fresh);
    expect(fresh.lives).toBe(3);
    expect(fresh.history).toEqual([]);
  });
  test("same-frame due dangers stop after first, freeze others, then give overdue untouched cards a decision window", () => {
    const s = batch(true),
      items = s.active.slice(0, 3);
    s.active = items;
    for (const item of items) item.deadline = s.elapsed + 100;
    tickFrame(s, 5000);
    expect(s.lives).toBe(2);
    expect(s.history).toHaveLength(1);
    expect(s.active.map((x) => x.uid)).toEqual(items.slice(1).map((x) => x.uid));
    const at = s.elapsed,
      born = s.active.map((x) => x.born);
    tickFrame(s, 50000);
    expect(s.elapsed).toBe(at);
    expect(s.lives).toBe(2);
    next(s);
    expect(s.active.map((x) => x.born)).toEqual(born);
    expect(s.active.every((x) => x.decisionDeadline === at + REVIEW_DECISION_MS)).toBe(true);
    tickFrame(s, 800 + REVIEW_DECISION_MS - 1);
    expect(s.lives).toBe(2);
    tickFrame(s, 1);
    expect(s.lives).toBe(1);
    expect(s.history).toHaveLength(2);
    next(s);
    tickFrame(s, 800 + REVIEW_DECISION_MS);
    expect(s.lives).toBe(0);
    expect(s.history).toHaveLength(3);
    expect(new Set(s.history.map((x) => x.uid)).size).toBe(3);
    next(s);
    expect(s.phase).toBe("finished");
  });
});
