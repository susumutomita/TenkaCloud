import { describe, expect, test } from "bun:test";
import { COPY } from "../../landing/work-dm/copy.js";
import { choose, elapse, ROUND_MS, start } from "../../landing/work-dm/model.js";

function site(variant = "install") {
  return choose(choose(choose(start(variant), "discuss"), "visit"), "begin");
}

describe("one work-network DM, prototype", () => {
  test("the unexpected install demand appears only after the natural exchange and simulated site", () => {
    const first = start("install");
    expect(first.stage).toBe("dm");
    expect(choose(first, "proceed")).toEqual(first);
    expect(choose(first, "verify").checked).toBe(false);
    expect(choose(first, "discuss").stage).toBe("invite");
    expect(site().stage).toBe("setup");
  });
  test("a real company alone never verifies the specific request", () => {
    let state = choose(choose(site(), "tools"), "company");
    expect(state.companyFound).toBe(true);
    expect(state.checked).toBe(false);
    state = choose(state, "close");
    expect(choose(state, "proceed").outcome).toBe("unsafe");
    expect(choose(state, "proceed").points).toBe(0);
  });
  test("the assessment page replaces the conversation before the install request is revealed", () => {
    const page = choose(choose(start("install"), "discuss"), "visit");
    expect(page.stage).toBe("site");
    expect(choose(page, "proceed")).toEqual(page);
    expect(choose(choose(page, "tools"), "verify").checked).toBe(false);
    expect(choose(page, "begin").stage).toBe("setup");
  });
  test("inspection actions never execute the requested app or grant the final reward", () => {
    const tools = choose(site(), "tools");
    expect(choose(tools, "proceed")).toEqual(tools);
    expect(choose(tools, "report")).toEqual(tools);
    const checked = choose(tools, "verify");
    expect(checked.points).toBe(0);
    expect(checked.outcome).toBeNull();
  });
  test("verify then safely report the malicious install request", () => {
    const state = choose(choose(choose(site(), "tools"), "verify"), "close");
    expect(choose(state, "report")).toMatchObject({ outcome: "resolved", points: 100 });
    expect(choose(state, "proceed")).toMatchObject({ outcome: "unsafe", points: 0 });
  });
  test("a legitimate request can be verified and completed without refusing it", () => {
    const state = choose(choose(choose(site("browser"), "tools"), "verify"), "close");
    expect(choose(state, "proceed")).toMatchObject({ outcome: "resolved", points: 100 });
    expect(choose(site("browser"), "proceed")).toMatchObject({ outcome: "limited", points: 50 });
  });
  test("hold and refusal are safe but differ from a verified resolution, for both variants", () => {
    for (const variant of ["browser", "install"]) {
      expect(choose(start(variant), "hold")).toMatchObject({ outcome: "held", points: 40 });
      expect(choose(site(variant), "hold").outcome).not.toBe("unsafe");
    }
    expect(choose(site(), "report")).toMatchObject({ outcome: "stopped", points: 70 });
  });
  test("30 seconds spans every stage; inspections alone pause it", () => {
    let state = elapse(start(), 10_000);
    state = choose(state, "discuss");
    expect(state.remaining).toBe(20_000);
    state = choose(choose(state, "tools"), "company");
    expect(elapse(state, 100_000).remaining).toBe(20_000);
    state = choose(state, "close");
    expect(elapse(state, 20_000)).toMatchObject({ outcome: "timeout", points: 0, remaining: 0 });
  });
  test("timeouts and terminal outcomes cannot gain points from subsequent clicks", () => {
    const state = elapse(site("browser"), ROUND_MS);
    for (const action of ["verify", "close", "proceed", "hold", "report", "visit"])
      expect(choose(state, action)).toEqual(state);
    const completed = choose(choose(choose(choose(site(), "tools"), "verify"), "close"), "report");
    expect(elapse(completed, ROUND_MS)).toEqual(completed);
    expect(choose(completed, "report").points).toBe(100);
  });
  test("invalid or extreme deltas cannot create negative, NaN or infinite timing", () => {
    for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(elapse(start(), delta).remaining).toBe(ROUND_MS);
    expect(elapse(start(), Number.MAX_VALUE).remaining).toBe(0);
    expect(start().remaining).toBe(ROUND_MS);
  });
  test("the player can stop at any stage; the evidence available determines credit", () => {
    expect(choose(start("install"), "hold")).toMatchObject({ points: 40, decisionStage: "dm" });
    expect(choose(site(), "hold")).toMatchObject({
      outcome: "stopped",
      points: 70,
      decisionStage: "setup",
    });
    const verified = choose(choose(choose(site(), "tools"), "verify"), "close");
    expect(choose(verified, "hold")).toMatchObject({ outcome: "resolved", points: 100 });
    const legitimate = choose(choose(choose(site("browser"), "tools"), "verify"), "close");
    expect(choose(legitimate, "hold")).toMatchObject({ outcome: "held", points: 40 });
  });
  test("clicking every control in order cannot undo a bad final decision or earn extra points", () => {
    for (const variant of ["install", "browser"]) {
      let state = start(variant);
      for (const action of [
        "discuss",
        "visit",
        "begin",
        "proceed",
        "tools",
        "company",
        "close",
        "tools",
        "verify",
        "close",
        "hold",
        "report",
        "proceed",
      ])
        state = choose(state, action);
      expect(state.points).toBe(variant === "install" ? 0 : 50);
      expect(state.points).toBeLessThanOrEqual(100);
    }
    const reset = start("install");
    expect(reset).toMatchObject({
      points: 0,
      checked: false,
      companyFound: false,
      outcome: null,
      panel: null,
      remaining: ROUND_MS,
    });
    expect(reset.decisionStage).toBeUndefined();
  });
  test("bilingual copy covers the same controls and never guarantees safety based on a profile", () => {
    expect(Object.keys(COPY.ja).sort()).toEqual(Object.keys(COPY.en).sort());
    for (const copy of Object.values(COPY))
      for (const value of Object.values(copy)) expect(value.length).toBeGreaterThan(0);
    expect(COPY.ja.nuance).toContain("すべて悪性という意味ではありません");
    expect(COPY.en.nuance).toContain("Not every");
  });
});
