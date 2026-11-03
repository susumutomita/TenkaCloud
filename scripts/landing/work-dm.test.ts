import { describe, expect, test } from "bun:test";
import { COPY, shareHref } from "../../landing/work-dm/copy.js";
import {
  choose,
  elapse,
  hits,
  ROUND_MS,
  score,
  start,
  TASKS,
} from "../../landing/work-dm/model.js";

function play(random = Math.random) {
  return start(random, false);
}

function shoot(state, id) {
  const next = choose(state, { type: "reveal", id });
  return choose(next, { type: "fire", id });
}
function revealAll(state) {
  return Object.keys(TASKS).reduce((next, id) => choose(next, { type: "reveal", id }), state);
}
function shape(value) {
  if (typeof value === "string") return "string";
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
}

describe("peel the recruiting disguise, direct action prototype", () => {
  test("first card teaches on-card interaction without points or consuming the main clock", () => {
    let state = start(() => 0);
    expect(state.phase).toBe("practice");
    expect(elapse(state, ROUND_MS * 10)).toEqual(state);
    expect(choose(state, { type: "begin" })).toEqual(state);
    expect(choose(state, { type: "fire", id: "practice" })).toEqual(state);
    state = choose(state, { type: "reveal", id: "practice" });
    expect(state.practiceRevealed).toBe(true);
    state = choose(state, { type: "fire", id: "practice" });
    expect(state.practiceShot).toBe(true);
    expect(score(state)).toBe(0);
    expect(state.shots).toEqual([]);
    expect(state.revealed).toEqual([]);
    expect(choose(state, { type: "fire", id: "practice" })).toEqual(state);
    state = choose(state, { type: "begin" });
    expect(state.phase).toBe("play");
    expect(state.remaining).toBe(ROUND_MS);
    expect(score(state)).toBe(0);
    expect(state.revealed).toEqual([]);
    expect(choose(state, { type: "begin" })).toEqual(state);
  });
  test("the main round starts with four stationary tasks and no hidden target-selection step", () => {
    const state = play();
    expect(new Set(state.order)).toEqual(new Set(Object.keys(TASKS)));
    expect(state.revealed).toEqual([]);
    expect(state.phase).toBe("play");
    expect(state.outcome).toBeNull();
    expect(score(state)).toBe(0);
    expect(ROUND_MS).toBe(120_000);
  });
  test("retry layout is randomized but always bounded, including invalid injected random values", () => {
    expect(play(() => 0).order).not.toEqual(play(() => 0.9).order);
    for (const value of [-1, 1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(new Set(play(() => value).order)).toEqual(new Set(Object.keys(TASKS)));
  });
  test("peeling does not award points or execute a request", () => {
    const state = revealAll(play());
    expect(state.revealed).toHaveLength(4);
    expect(state.shots).toEqual([]);
    expect(score(state)).toBe(0);
    expect(state.outcome).toBeNull();
  });
  test("shooting requires only a visible payload, not target selection or hidden investigation clicks", () => {
    const state = play(() => 0);
    expect(choose(state, { type: "fire", id: "application" })).toEqual(state);
    expect(choose(state, { type: "fire", id: "application" })).toEqual(state);
    expect(score(shoot(state, "application"))).toBe(50);
  });
  test("the two concrete policy conflicts earn100 in either order, without investigation prerequisites", () => {
    for (const order of [
      ["application", "upload"],
      ["upload", "application"],
    ]) {
      let state = revealAll(play());
      for (const id of order) state = shoot(state, id);
      expect(score(state)).toBe(100);
      expect(hits(state)).toBe(2);
      expect(choose(state, { type: "finish" }).outcome).toBe("complete");
    }
  });
  test("shooting every task earns only50; later correct shots do not erase wrong shots", () => {
    let state = play();
    for (const id of Object.keys(TASKS)) state = shoot(state, id);
    expect(state.shots).toHaveLength(4);
    expect(score(state)).toBe(50);
    expect(choose(state, { type: "finish" }).outcome).toBe("complete");
    const wrongThenRight = shoot(shoot(play(), "calendar"), "application");
    expect(score(wrongThenRight)).toBe(25);
  });
  test("a target cannot receive duplicate rewards or penalties from rapid clicks", () => {
    for (const id of Object.keys(TASKS)) {
      const state = shoot(play(), id);
      expect(shoot(state, id)).toEqual(state);
      expect(choose(state, { type: "fire", id: "application" })).toEqual(state);
    }
  });
  test("finishing a revealed but untouched board scores0; hidden tasks cannot be graded as completed", () => {
    const state = play(() => 0);
    expect(choose(state, { type: "finish" })).toEqual(state);
    const done = choose(revealAll(state), { type: "finish" });
    expect(done.outcome).toBe("complete");
    expect(score(done)).toBe(0);
  });
  test("early safe stopping is ungraded, not a failed or low-scoring judgement", () => {
    const held = choose(choose(play(), { type: "pause" }), { type: "hold" });
    expect(held.outcome).toBe("held");
    expect(COPY.ja.heldNote).toContain("採点なし");
    expect(COPY.en.heldNote).toContain("Not graded");
    expect(elapse(held, ROUND_MS)).toEqual(held);
  });
  test("pause preserves time and blocks play; resume restores the same peeled targets and score", () => {
    const playing = shoot(play(), "application");
    const paused = choose(playing, { type: "pause" });
    expect(elapse(paused, ROUND_MS)).toEqual(paused);
    expect(shoot(paused, "upload")).toEqual(paused);
    const resumed = choose(paused, { type: "resume" });
    expect(resumed.remaining).toBe(playing.remaining);
    expect(resumed.revealed).toEqual(playing.revealed);
    expect(score(resumed)).toBe(50);
  });
  test("unanswered timeout is0, earned partial points remain, and no final actions add scores", () => {
    const unanswered = elapse(play(), ROUND_MS);
    const partial = elapse(shoot(play(), "application"), ROUND_MS);
    expect(unanswered.outcome).toBe("timeout");
    expect(score(unanswered)).toBe(0);
    expect(score(partial)).toBe(50);
    for (const ended of [unanswered, partial, choose(revealAll(play()), { type: "finish" })]) {
      for (const type of ["reveal", "fire", "pause", "resume", "hold", "finish", "begin"])
        expect(choose(ended, { type, id: "upload" })).toEqual(ended);
      expect(elapse(ended, ROUND_MS)).toEqual(ended);
    }
  });
  test("restart resets all effects, target, score and timing, with finite timing at extremes", () => {
    shoot(play(), "application");
    const reset = play();
    expect(reset.shots).toEqual([]);
    expect(reset.revealed).toEqual([]);
    expect(reset.flash).toBeNull();
    expect(reset.phase).toBe("play");
    expect(reset.paused).toBe(false);
    expect(reset.remaining).toBe(ROUND_MS);
    for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(elapse(reset, delta)).toEqual(reset);
    expect(elapse(reset, Number.MAX_VALUE).remaining).toBe(0);
    for (const type of ["toString", "__proto__", "unknown"])
      expect(choose(reset, { type })).toEqual(reset);
    expect(choose(reset, { type: "reveal", id: "__proto__" })).toEqual(reset);
  });
  test("both languages expose the same facts and explain the case policy, not universal app or domain guilt", () => {
    expect(shape(COPY.ja)).toEqual(shape(COPY.en));
    expect(Object.keys(COPY.ja.covers).sort()).toEqual(Object.keys(TASKS).sort());
    expect(COPY.ja.safeNext).toContain("常に悪性とは限りません");
    expect(COPY.en.safeNext).toContain("not inherently malicious");
    expect(TASKS.application.kind).toBe("APP");
    expect(TASKS.upload.site).not.toBe("aoba");
    for (const id of ["calendar", "task"])
      expect(TASKS[id]).toMatchObject({ kind: "WEB", site: "aoba", mismatch: null });
  });
  test("SNS and phone each contain a legitimate request and a conflicting request; medium is not the grading rule", () => {
    expect(TASKS.application.medium).toBe("sns");
    expect(TASKS.task.medium).toBe("sns");
    expect(TASKS.calendar.medium).toBe("phone");
    expect(TASKS.upload.medium).toBe("phone");
    for (const medium of ["sns", "phone"]) {
      let state = play();
      const requests = Object.keys(TASKS).filter((id) => TASKS[id].medium === medium);
      expect(requests).toHaveLength(2);
      expect(requests.filter((id) => TASKS[id].mismatch)).toHaveLength(1);
      for (const id of requests) state = shoot(state, id);
      expect(score(state)).toBe(25);
    }
  });
  test("read recruiting history establishes role, work conditions and agreed interview before the assessment", () => {
    expect(COPY.ja.history).toHaveLength(5);
    expect(COPY.en.history).toHaveLength(5);
    expect(COPY.ja.history[0].text).toContain("予約ページ");
    expect(COPY.ja.history[2].text).toContain("週3日");
    expect(COPY.ja.history[3].text).toContain("火曜の17時");
    expect(COPY.ja.history[4].text).toContain("スキルチェック");
    expect(COPY.en.history[2].text).toContain("three days");
    expect(COPY.en.history[3].text).toContain("Tuesday at 17:00");
    expect(COPY.en.history[4].text).toContain("assessment");
    expect(COPY.ja.requests.application).toContain("環境をそろえる");
    expect(COPY.ja.previews.upload).toContain("SNS");
    expect(COPY.ja.requests.upload).toContain("DM");
    expect(COPY.en.requests.upload).toContain("DM");
  });
  test("manual X intent encodes actual results and current reachable game URL without spoilers or private query data", () => {
    for (const lang of ["ja", "en"]) {
      const state = choose(revealAll(shoot(play(), "application")), { type: "finish" });
      const u = new URL(
        shareHref(
          state,
          lang,
          "https://preview.example/work-dm/?private=not-for-sharing#debug",
          score(state),
          hits(state),
        ),
      );
      expect(u.origin).toBe("https://twitter.com");
      expect(u.pathname).toBe("/intent/tweet");
      expect(u.searchParams.get("text")).toContain("50/100");
      expect(u.searchParams.get("text")).not.toContain("aoba-skills");
      expect(u.searchParams.get("url")).toBe(`https://preview.example/work-dm/?lang=${lang}`);
      const held = choose(choose(play(), { type: "pause" }), { type: "hold" });
      const text = new URL(
        shareHref(held, lang, "https://preview.example/work-dm/", 0, 0),
      ).searchParams.get("text");
      expect(text).not.toContain("0/100");
      expect(text).toContain(lang === "ja" ? "採点なし" : "not graded");
    }
  });
});
