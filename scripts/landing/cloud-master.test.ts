import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import manifest from "../../landing/cloud-master/api-catalog-manifest.json";
import {
  collect,
  createGame,
  finish,
  HITSTOP_MS,
  next,
  passStudy,
  pause,
  resume,
  start,
  tick,
} from "../../landing/cloud-master/engine.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import {
  availableScenarios,
  createQuestionStream,
  difficulty,
  levelFor,
  nextQuestion,
  violates,
} from "../../landing/cloud-master/recognition.js";
import { buildShare } from "../../landing/cloud-master/share.js";

const catalog = await loadCatalog();
function playing(seed = 726) {
  const state = createGame(catalog, seed);
  start(state);
  return state;
}
function findOpening(danger, points = null) {
  for (let seed = 0; seed < 50; seed++) {
    const state = playing(seed);
    if (
      state.active[0].question.danger === danger &&
      (points === null || state.active[0].question.points === points)
    )
      return state;
  }
  throw new Error("Missing balanced seed");
}
function afterDelay(state) {
  tick(state, 301);
  return state.active[0];
}

describe("pinned public AWS API catalog and visible policy keys", () => {
  test("exact coverage, source digest and all API templates validate", () => {
    expect(catalog).toHaveLength(435);
    expect(manifest.serviceModels).toBe(435);
    expect(manifest.operations).toBe(19437);
    expect(manifest.excludedOperations).toHaveLength(0);
    expect(manifest.excludedOlderApiVersions).toHaveLength(33);
    expect(createHash("sha256").update(JSON.stringify(catalog)).digest("hex")).toBe(
      manifest.plainSha256,
    );
    let operations = 0;
    for (const service of catalog) {
      expect(service.name.length).toBeGreaterThan(0);
      expect(service.operations.length).toBeGreaterThan(0);
      for (const [name, method, path] of service.operations) {
        expect(name.length).toBeGreaterThan(0);
        expect(method).toMatch(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/u);
        expect(path.startsWith("/")).toBe(true);
        operations++;
      }
    }
    expect(operations).toBe(19437);
  });
  test("all authored cases have model-backed operations, visible payloads and reproducible balanced variants", () => {
    const a = createQuestionStream(catalog, 123),
      b = createQuestionStream(catalog, 123);
    a.elapsed = b.elapsed = 120000;
    const kinds = new Set(),
      cases = new Set();
    let dangerous = 0;
    for (let i = 0; i < 6000; i++) {
      const q = nextQuestion(a);
      expect(q).toEqual(nextQuestion(b));
      if (q.serviceId !== "signin" && !q.protocol.startsWith("synthetic-"))
        expect(
          catalog.find((m) => m.id === q.serviceId).operations.some((op) => op[0] === q.operation),
        ).toBe(true);
      else
        expect(q.protocol === "cloudtrail-event" || q.protocol.startsWith("synthetic-")).toBe(true);
      expect(q.payload).toContain(q.context.observed);
      expect(q.wire).toContain(q.operation);
      expect(q.context.policy.length).toBeGreaterThan(12);
      expect(q.danger).toBe(violates(q.context));
      expect(q.points).toBe(q.danger ? Math.round(q.severity * 10) : 10);
      expect(q.source).toStartWith("https://docs.aws.amazon.com/guardduty/");
      kinds.add(q.scenarioId);
      cases.add(`${q.scenarioId}:${q.danger}`);
      dangerous += Number(q.danger);
    }
    expect(kinds.size).toBe(availableScenarios(catalog).length);
    expect(cases.size).toBe(availableScenarios(catalog).length * 2);
    expect(dangerous).toBe(3000);
  });
  test("same API has opposite decisions based on actual security parameters", () => {
    const s = createQuestionStream(catalog, 15);
    s.elapsed = 120000;
    const rds = [];
    for (let i = 0; i < 6000; i++) {
      const q = nextQuestion(s);
      if (q.scenarioId === "RDSPubliclyAccessible") rds.push(q);
    }
    expect(rds.some((q) => q.danger)).toBe(true);
    expect(rds.some((q) => !q.danger)).toBe(true);
    for (const q of rds) expect(q.danger).toBe(q.parameters.PubliclyAccessible === true);
  });
  test("all public finding and custom signal rows have explicit implementation status", () => {
    const c = coverage;
    expect(c.active).toHaveLength(211);
    expect(c.customSignals).toHaveLength(35);
    expect(c.retired).toHaveLength(21);
    for (const row of [...c.active, ...c.customSignals]) {
      expect(["educational_case", "pending"]).toContain(row.implementation);
      expect(row.sourceUrl).toStartWith("https://docs.aws.amazon.com/");
      if (row.implementation === "pending") expect(row.reason.length).toBeGreaterThan(15);
    }
    expect(
      c.customSignals.find((x) => x.signalName === "S3CustomerProvidedKeysEnabled").implementation,
    ).toBe("educational_case");
  });
});

describe("levels, finite incoming stream and exact scoring", () => {
  test("survival time continuously accelerates pressure, not score, without a3minute cutoff", () => {
    expect([0, 14999, 15000, 180000, 360000].map(levelFor)).toEqual([1, 1, 2, 13, 25]);
    let fall = Infinity,
      interval = Infinity;
    for (let elapsed = 0; elapsed <= 360000; elapsed += 1000) {
      const d = difficulty(elapsed);
      expect(d.fallMs).toBeLessThanOrEqual(fall);
      expect(d.intervalMs).toBeLessThanOrEqual(interval);
      expect(d.fallMs).toBeGreaterThanOrEqual(4200);
      fall = d.fallMs;
      interval = d.intervalMs;
    }
    expect(difficulty(360000).fallMs).toBeLessThan(difficulty(180000).fallMs);
    expect(difficulty(180000).level).toBeGreaterThan(5);
  });
  test("every semantic tier remains balanced and all deciding evidence stays visible", () => {
    for (const elapsed of [0, 30000, 90000]) {
      const stream = createQuestionStream(catalog, 42);
      stream.elapsed = elapsed;
      let flags = 0;
      for (let i = 0; i < 120; i++) {
        const q = nextQuestion(stream);
        expect(q.payload).toBe(q.context.observed);
        expect(q.context.policy.length).toBeGreaterThan(12);
        expect(q.danger).toBe(violates(q.context));
        flags += Number(q.danger);
      }
      expect(flags).toBe(60);
    }
  });
  test("round starts sparse, later objects arrive and any recognized upper item can be flagged", () => {
    let state = playing(0);
    for (let seed = 0; seed < 50; seed++) {
      const candidate = playing(seed);
      tick(candidate, 1501);
      if (candidate.active[1]?.question.danger) {
        state = candidate;
        break;
      }
    }
    expect(state.active).toHaveLength(2);
    const upper = state.active[1];
    expect(collect(state, upper.uid)).toBe(true);
    expect(state.history[0].uid).toBe(upper.uid);
    expect(state.active[0].uid).toBe(0);
  });
  test("normal pass gets10 exactly once at the boundary", () => {
    const s = findOpening(false),
      item = s.active[0];
    tick(s, item.deadline - 1);
    expect(s.score).toBe(0);
    tick(s, 1);
    expect(s.score).toBe(10);
    expect(s.passed).toBe(1);
    expect(collect(s, item.uid)).toBe(false);
    expect(s.score).toBe(10);
  });
  test("normal false positive costs life and never later receives pass points", () => {
    const s = findOpening(false),
      item = afterDelay(s);
    expect(collect(s, item.uid)).toBe(true);
    expect(s.lives).toBe(2);
    expect(s.score).toBe(0);
    tick(s, item.deadline - s.elapsed);
    expect(s.history.filter((entry) => entry.uid === item.uid)).toHaveLength(1);
    expect(s.history.find((entry) => entry.uid === item.uid).points).toBe(0);
  });
  test("danger score is severity times10, hitstop applies only to the10point hit", () => {
    const s = findOpening(true, 10),
      item = afterDelay(s);
    expect(item.question.points).toBe(10);
    expect(collect(s, item.uid)).toBe(true);
    expect(s.score).toBe(10);
    expect(s.phase).toBe("hitstop");
    const elapsed = s.elapsed;
    tick(s, HITSTOP_MS - 1);
    expect(s.elapsed).toBe(elapsed);
    expect(s.phase).toBe("hitstop");
    expect(collect(s, item.uid)).toBe(false);
    tick(s, 1);
    expect(s.phase).toBe("playing");
    expect(s.elapsed).toBe(elapsed);
    tick(s, 20);
    expect(s.elapsed).toBe(elapsed + 20);
  });
  test("hitstop consumes frame time without moving the game clock, including pause/resume", () => {
    const s = findOpening(true, 10),
      item = afterDelay(s);
    collect(s, item.uid);
    pause(s);
    const before = JSON.stringify({ ...s, catalog: null });
    tick(s, 9999);
    expect(JSON.stringify({ ...s, catalog: null })).toBe(before);
    resume(s);
    const elapsed = s.elapsed;
    tick(s, 150);
    expect(s.elapsed).toBe(elapsed + 30);
    expect(s.score).toBe(10);
  });
  test("higher severity is worth more and never gets the10-point hitstop", () => {
    let state = playing(0);
    for (let seed = 0; seed < 100; seed++) {
      const candidate = createGame(catalog, seed);
      candidate.elapsed = 90000;
      start(candidate);
      if (candidate.active[0].question.danger && candidate.active[0].question.points > 10) {
        state = candidate;
        break;
      }
    }
    const item = afterDelay(state);
    expect(item.question.points).toBeGreaterThan(10);
    collect(state, item.uid);
    expect(state.score).toBe(item.question.points);
    expect(state.phase).toBe("playing");
  });
  test("normal pass never triggers success hitstop", () => {
    const s = findOpening(false);
    tick(s, s.active[0].deadline);
    expect(s.phase).not.toBe("hitstop");
  });
  test("narrow display cap and progressive spawn interval are deterministic", () => {
    const s = playing(3);
    s.maxCards = 2;
    s.correct = 20;
    tick(s, 10000);
    expect(s.active.length).toBeLessThanOrEqual(2);
    expect(difficulty(90000).intervalMs).toBeLessThan(difficulty(0).intervalMs);
  });
});

describe("active survival clock", () => {
  test("skilled play continues beyond3minutes and pauses cannot inflate elapsed", () => {
    const s = playing(6);
    for (let wall = 0; wall < 205000; wall += 20) {
      tick(s, 20);
      if (s.phase === "playing")
        for (const item of [...s.active]) if (item.question.danger) collect(s, item.uid);
    }
    expect(s.phase === "playing" || s.phase === "hitstop").toBe(true);
    expect(s.elapsed).toBeGreaterThan(180000);
    const time = s.elapsed;
    pause(s);
    tick(s, 999999);
    expect(s.elapsed).toBe(time);
    resume(s);
    tick(s, 20);
    expect(s.elapsed).toBeLessThanOrEqual(time + 20);
    expect(s.lives).toBe(3);
  });
  test("restart resets time and study never accumulates survival time", () => {
    const a = playing(8);
    tick(a, 11000);
    expect(a.elapsed).toBeGreaterThan(10000);
    const b = playing(8);
    expect(b.elapsed).toBe(0);
    const study = createGame(catalog, 8, true);
    start(study);
    tick(study, 900000);
    expect(study.elapsed).toBe(0);
  });
  test("synthetic enrichment never masquerades as an API input member", () => {
    const stream = createQuestionStream(catalog, 28);
    stream.elapsed = 90000;
    for (let i = 0; i < 500; i++) {
      const q = nextQuestion(stream);
      expect(Object.keys(q.parameters).some((k) => k.startsWith("eventContext"))).toBe(false);
      if (q.scenarioId === "RDSMasterPasswordReset")
        expect(q.parameters.MasterUserPassword).toBe("[REDACTED]");
      if (q.scenarioId === "OrganizationLeaveAttempt") expect(q.parameters).toEqual({});
      if (q.serviceId === "signin") expect(q.wire).toStartWith("合成CloudTrailイベント");
    }
  });
});
describe("miss explanations, races and farming guards", () => {
  test("miss freezes all time until understood; final miss explains before results", () => {
    const s = playing(42);
    for (let i = 0; i < 3; i++) {
      tick(s, 100000);
      expect(s.phase).toBe("feedback");
      expect(s.feedback.kind).toBe("miss");
      const before = JSON.stringify({ ...s, catalog: null });
      tick(s, 999999);
      expect(JSON.stringify({ ...s, catalog: null })).toBe(before);
      next(s);
      if (s.lives === 0) break;
    }
    expect(s.lives).toBe(0);
    expect(s.phase).toBe("finished");
    expect(s.end.reason).toBe("lives");
  });
  test("expired dangerous card cannot be scored or cost another life from a stale tap", () => {
    const s = findOpening(true, 10),
      item = s.active[0];
    tick(s, item.deadline);
    const lives = s.lives;
    expect(collect(s, item.uid)).toBe(false);
    expect(s.lives).toBe(lives);
    expect(s.feedback.kind).toBe("miss");
  });
  test("double clicks and invalid IDs never score twice", () => {
    const s = findOpening(true, 10),
      item = afterDelay(s);
    expect(collect(s, item.uid)).toBe(true);
    expect(collect(s, item.uid)).toBe(false);
    expect(collect(s, 9999)).toBe(false);
    expect(s.score).toBe(10);
    expect(s.history).toHaveLength(1);
  });
  test("large frame and split frames produce the same first explanation", () => {
    const a = playing(444),
      b = playing(444);
    tick(a, 100000);
    for (let i = 0; i < 100; i++) tick(b, 1000);
    expect({ ...a, catalog: null }).toEqual({ ...b, catalog: null });
  });
  test("inaction cannot farm indefinitely; score freezes with a missed target", () => {
    const s = playing(84);
    for (let i = 0; i < 3; i++) {
      tick(s, 100000);
      const score = s.score;
      tick(s, 10000000);
      expect(s.score).toBe(score);
      next(s);
    }
    expect(s.phase).toBe("finished");
    expect(s.lives).toBe(0);
    expect(s.passed).toBeLessThan(15);
  });
  test("blind tapping ends after three mistakes instead of farming indefinitely", () => {
    const s = playing(55);
    for (let step = 0; step < 500 && s.phase !== "finished"; step++) {
      tick(s, 500);
      if (s.phase === "feedback") {
        next(s);
        continue;
      }
      for (const item of [...s.active]) collect(s, item.uid);
    }
    expect(s.lives).toBe(0);
    expect(s.phase).toBe("finished");
    expect(s.mistakes).toBe(3);
    expect(s.history.filter((entry) => !entry.correct).every((entry) => entry.points === 0)).toBe(
      true,
    );
  });
  test("untimed study, manual end and seeded retry remain available", () => {
    const s = createGame(catalog, 88, true);
    start(s);
    tick(s, 1000000);
    expect(s.elapsed).toBe(0);
    const q = s.active[0];
    if (q.question.danger) collect(s, q.uid);
    else passStudy(s);
    expect(s.phase).toBe("feedback");
    next(s);
    expect(s.phase).toBe("playing");
    finish(s);
    expect(s.end.reason).toBe("manual");
    expect(createGame(catalog, 88, true)).toEqual(createGame(catalog, 88, true));
  });
  test("sharing is an encoded user-triggered compose URL, with preview scope explicit", () => {
    const s = playing(99);
    s.score = 125;
    s.correct = 2;
    s.passed = 3;
    const result = buildShare(s, { hostname: "localhost" }),
      url = new URL(result.intent);
    expect(url.origin + url.pathname).toBe("https://x.com/intent/tweet");
    expect(url.searchParams.get("text")).toContain("125 pt");
    expect(url.searchParams.get("text")).toContain("プレビュー");
    expect(url.searchParams.get("url")).toBe(
      "https://feat-cloud-master-game.tenkacloud-www.pages.dev/cloud-master/",
    );
    expect(buildShare(s, { hostname: "tenkacloud.com" }).url).toBe(
      "https://tenkacloud.com/cloud-master/",
    );
  });
});
