import { describe, expect, test } from "bun:test";
import { COPY } from "../../landing/work-dm/copy.js";
import {
  CONNECTIONS,
  choose,
  elapse,
  ROUND_MS,
  SOURCES,
  score,
  start,
} from "../../landing/work-dm/model.js";

function collect(state, id) {
  return choose(choose(state, { type: "open", view: SOURCES[id] }), { type: "collect", id });
}
function pair(state, a, b) {
  let next = collect(collect(state, a), b);
  next = choose(choose(next, { type: "select", id: a }), { type: "select", id: b });
  return choose(next, { type: "connect" });
}
function prove(state, id) {
  const connected = pair(state, ...CONNECTIONS[id]);
  return choose(choose(connected, { type: "arm", id }), { type: "present" });
}
function shape(value) {
  if (typeof value === "string") return "string";
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
}

describe("work-DM evidence investigation", () => {
  test("a case opens directly on the DM; every source is available without hidden gates", () => {
    let state = start();
    expect(state.view).toBe("dm");
    expect(ROUND_MS).toBe(120_000);
    for (const view of ["official", "assessment", "profile", "dm"]) {
      state = choose(state, { type: "open", view });
      expect(state.view).toBe(view);
      expect(score(state)).toBe(0);
    }
  });
  test("collecting everything, visiting every screen and tapping cards earns no score", () => {
    let state = start();
    for (const id of Object.keys(SOURCES)) state = collect(state, id);
    expect(state.collected).toHaveLength(8);
    for (const id of state.collected) state = choose(state, { type: "select", id });
    expect(state.selected.length).toBeLessThanOrEqual(2);
    expect(score(state)).toBe(0);
    expect(state.outcome).toBeNull();
  });
  test("facts must be seen at their source and saved before selecting; unknown controls are inert", () => {
    expect(choose(start(), { type: "collect", id: "application" })).toEqual(start());
    expect(choose(start(), { type: "select", id: "application" })).toEqual(start());
    for (const type of ["proceed", "hold", "verify", "toString", "__proto__"])
      expect(choose(start(), { type })).toEqual(start());
    expect(choose(start(), { type: "open", view: "unknown" })).toEqual(start());
  });
  test("a contradiction must be connected and presented on the actual request, not merely collected", () => {
    let state = pair(start(), ...CONNECTIONS.software);
    expect(state.connected).toEqual(["software"]);
    expect(score(state)).toBe(0);
    expect(choose(state, { type: "present" })).toEqual(state);
    state = choose(state, { type: "arm", id: "software" });
    expect(state.view).toBe("dm");
    state = choose(state, { type: "present" });
    expect(score(state)).toBe(50);
    expect(state.presented).toEqual(["software"]);
    expect(state.outcome).toBeNull();
  });
  test("both supported contradictions resolve the case for100, in either order", () => {
    for (const order of [
      ["location", "software"],
      ["software", "location"],
    ]) {
      let state = start();
      for (const id of order) state = prove(state, id);
      expect(score(state)).toBe(100);
      expect(state.outcome).toBe("solved");
      expect(state.presented).toHaveLength(2);
    }
  });
  test("two consistent facts do not become a contradiction because both were clicked", () => {
    const state = pair(start(), "deadline", "officialDeadline");
    expect(state.mistakes).toBe(1);
    expect(state.connected).toHaveLength(0);
    expect(state.notice).toBe("mismatch");
    expect(score(state)).toBe(0);
    const found = prove(prove(state, "location"), "software");
    expect(score(found)).toBe(90);
  });
  test("repeated facts, pairs and presentation cannot duplicate rewards or penalties", () => {
    let state = pair(start(), "deadline", "officialDeadline");
    state = pair(state, "officialDeadline", "deadline");
    expect(state.mistakes).toBe(1);
    state = prove(state, "software");
    const points = score(state);
    state = choose(state, { type: "present" });
    state = pair(state, ...CONNECTIONS.software);
    state = choose(state, { type: "arm", id: "software" });
    expect(score(state)).toBe(points);
    expect(state.presented).toHaveLength(1);
    expect(state.connected).toHaveLength(1);
  });
  test("three distinct unsupported pairs stop brute-force comparison before exhaustive guessing", () => {
    let state = start();
    for (const ids of [
      ["deadline", "role"],
      ["deadline", "officialRole"],
      ["role", "officialRole"],
    ])
      state = pair(state, ...ids);
    expect(state.outcome).toBe("unresolved");
    expect(state.attempted).toHaveLength(3);
    expect(score(state)).toBe(0);
    expect(prove(state, "location")).toEqual(state);
  });
  test("no input times out to zero; earned partial points remain, with no reveal points", () => {
    expect(score(elapse(start(), ROUND_MS))).toBe(0);
    const ended = elapse(prove(start(), "software"), ROUND_MS);
    expect(ended.outcome).toBe("timeout");
    expect(score(ended)).toBe(50);
    expect(prove(ended, "location")).toEqual(ended);
  });
  test("terminal actions and animation frames cannot change final scores", () => {
    for (const ended of [
      elapse(start(), ROUND_MS),
      prove(prove(start(), "software"), "location"),
    ]) {
      expect(elapse(ended, ROUND_MS)).toEqual(ended);
      for (const type of ["collect", "select", "connect", "open", "board", "arm", "present"])
        expect(choose(ended, { type, id: "domain", view: "dm", open: true })).toEqual(ended);
      expect(score(ended)).toBeLessThanOrEqual(100);
    }
  });
  test("restart returns an independent clean case and timings stay finite", () => {
    const previous = prove(start(), "software");
    const reset = start();
    expect(reset.collected).toEqual([]);
    expect(reset.selected).toEqual([]);
    expect(reset.connected).toEqual([]);
    expect(reset.presented).toEqual([]);
    expect(reset.attempted).toEqual([]);
    expect(reset.mistakes).toBe(0);
    expect(reset.armed).toBeNull();
    expect(reset.remaining).toBe(ROUND_MS);
    expect(previous.presented).toEqual(["software"]);
    for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(elapse(reset, delta)).toEqual(reset);
    expect(elapse(reset, Number.MAX_VALUE).remaining).toBe(0);
  });
  test("bilingual evidence has the same IDs; each solution has an explicit independent reference", () => {
    expect(shape(COPY.ja)).toEqual(shape(COPY.en));
    expect(Object.keys(COPY.ja.facts).sort()).toEqual(Object.keys(SOURCES).sort());
    expect(COPY.ja.facts.officialDomain).toContain("外部の試験サイトは使いません");
    expect(COPY.en.facts.officialDomain).toContain("do not use external");
    expect(COPY.ja.facts.officialApplication).toContain("インストールは行いません");
    expect(COPY.en.facts.officialApplication).toContain("do not distribute");
    expect(COPY.ja.nuance).toContain("外部サイトだから危険なのではありません");
    expect(COPY.en.nuance).toContain("not inherently dangerous");
  });
});
