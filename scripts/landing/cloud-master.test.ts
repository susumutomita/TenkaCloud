import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import manifest from "../../landing/cloud-master/api-catalog-manifest.json";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  finish,
  HITSTOP_MS,
  next,
  pause,
  resume,
  showLesson,
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
  PRESSURE_STAGES,
  pressureFor,
  violates,
} from "../../landing/cloud-master/recognition.js";
import { buildShare } from "../../landing/cloud-master/share.js";

const catalog = await loadCatalog();
function playing(seed = 726, advanced = false) {
  const state = createGame(catalog, seed);
  if (advanced) {
    state.taughtLevel = LESSONS.length;
    state.pressureIndex = 10;
  }
  start(state);
  return state;
}
function findOpening(danger, points = null) {
  for (let seed = 0; seed < 1000; seed++) {
    const state = playing(seed, points === 10);
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

function untilMistake(s) {
  for (let frame = 0; frame < 1000 && s.phase !== "feedback"; frame++) {
    if (s.lessonNotice) showLesson(s);
    tick(s, 100);
  }
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
    a.elapsed = b.elapsed = 300000;
    a.taughtLevel = b.taughtLevel = LESSONS.length;
    b.taughtLevel = LESSONS.length;
    b.pressureIndex = 10;
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
      expect(new URL(q.source).hostname).toBe("docs.aws.amazon.com");
      expect([
        "/guardduty/",
        "/IAM/",
        "/systems-manager/",
        "/AWSEC2/",
        "/AmazonRDS/",
        "/elasticloadbalancing/",
        "/cloudfront/",
        "/waf/",
      ]).toContain(`/${new URL(q.source).pathname.split("/")[1]}/`);
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
    s.elapsed = 300000;
    s.taughtLevel = LESSONS.length;
    s.pressureIndex = 10;
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
  test("correct decisions add levels and pressure without a time or forced-ending gate", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(4)).toBe(1);
    expect(levelFor(5)).toBe(2);
    expect(levelFor(85)).toBe(18);
    expect(levelFor(90)).toBe(19);
    let fall = Infinity,
      interval = Infinity,
      limit = 0;
    for (const p of PRESSURE_STAGES) {
      const d = difficulty(p.level);
      expect(d.fallMs).toBeLessThanOrEqual(fall);
      expect(d.intervalMs).toBeLessThanOrEqual(interval);
      expect(d.limit).toBeGreaterThanOrEqual(limit);
      fall = d.fallMs;
      interval = d.intervalMs;
      limit = d.limit;
    }
    expect(difficulty(18)).toMatchObject({ fallMs: 4200, intervalMs: 280, limit: 6, tier: 3 });
  });
  test("every semantic tier remains balanced and all deciding evidence stays visible", () => {
    for (const level of [1, 6, 18]) {
      const stream = createQuestionStream(catalog, 42);
      stream.taughtLevel = level;
      stream.pressureIndex = pressureFor(level);
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
  test("after level2 later objects arrive and any recognized upper item can be flagged", () => {
    let state = playing(0);
    for (let seed = 0; seed < 50; seed++) {
      const candidate = createGame(catalog, seed);
      Object.assign(candidate, { level: 2, taughtLevel: 2, pressureIndex: 1, correct: 5 });
      start(candidate);
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
  test("danger score stays severity times10 and correct hits never stop play", () => {
    const s = findOpening(true, 10),
      item = afterDelay(s);
    expect(item.question.points).toBe(10);
    expect(collect(s, item.uid)).toBe(true);
    expect(s.score).toBe(10);
    expect(HITSTOP_MS).toBe(0);
    expect(s.phase).toBe("playing");
    const elapsed = s.elapsed;
    tick(s, 20);
    expect(s.elapsed).toBe(elapsed + 20);
    expect(collect(s, item.uid)).toBe(false);
    expect(s.score).toBe(10);
  });
  test("correct-hit effects do not consume play time; explicit pause still stops the clock", () => {
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
    expect(s.elapsed).toBe(elapsed + 150);
    expect(s.score).toBe(10);
  });
  test("higher severity remains worth more while play keeps flowing", () => {
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
    expect(difficulty(18).intervalMs).toBeLessThan(difficulty(0).intervalMs);
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
  test("restart resets active survival time", () => {
    const a = playing(8);
    tick(a, 9000);
    expect(a.elapsed).toBeGreaterThan(8000);
    const b = playing(8);
    expect(b.elapsed).toBe(0);
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
      untilMistake(s);
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
      untilMistake(s);
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
  test("manual end and seeded retry remain available in the single survival mode", () => {
    const s = createGame(catalog, 88);
    start(s);
    tick(s, 1000);
    finish(s);
    expect(s.end.reason).toBe("manual");
    expect(createGame(catalog, 88)).toEqual(createGame(catalog, 88));
    expect(s).not.toHaveProperty("study");
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
