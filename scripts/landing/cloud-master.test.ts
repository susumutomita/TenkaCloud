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
import {
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
function findOpening(danger) {
  for (let seed = 0; seed < 50; seed++) {
    const state = playing(seed);
    if (state.active[0].question.danger === danger) return state;
  }
  throw new Error("Missing balanced seed");
}
function afterDelay(state) {
  tick(state, 301);
  return state.active[0];
}

function expectVisibleParameters(q: ReturnType<typeof nextQuestion>) {
  if (q.context.kind === "service") expect(q.context.actual).toBe(q.service);
  if (q.context.kind === "acl") expect(q.wire).toContain(`x-amz-acl: ${q.context.actual}`);
  if (q.context.kind === "keyOwner") expect(q.wire).toContain(`UserName=${q.context.actual}`);
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
  test("seeded generation binds actual model operations and grades only visible context", () => {
    const a = createQuestionStream(catalog, 123),
      b = createQuestionStream(catalog, 123);
    a.correct = b.correct = 15;
    const kinds = new Set();
    const cases = new Set();
    let dangerous = 0;
    for (let i = 0; i < 1200; i++) {
      const q = nextQuestion(a);
      expect(q).toEqual(nextQuestion(b));
      const model = catalog.find((s) => s.id === q.serviceId);
      expect(
        model.operations.some(
          (op) =>
            op[0] === q.operation &&
            op[1] === q.method &&
            (q.protocol === "smithy-rpc-v2-cbor" || op[2] === q.path),
        ),
      ).toBe(true);
      expect(q.danger).toBe(violates(q.context));
      expectVisibleParameters(q);
      expect(q.points).toBe(q.danger ? Math.round(q.severity * 10) : 10);
      expect(q.wire).toContain(`${q.method} ${q.path}`);
      if (q.protocol === "smithy-rpc-v2-cbor") {
        expect(q.path).toBe(`/service/${model.target}/operation/${q.operation}`);
        expect(q.wire).toContain("Smithy-Protocol: rpc-v2-cbor");
        expect(q.wire).not.toContain("X-Amz-Target:");
      }
      kinds.add(q.context.kind);
      cases.add(`${q.context.kind}:${q.danger}`);
      dangerous += Number(q.danger);
    }
    expect(kinds.size).toBe(6);
    expect(cases.size).toBe(12);
    expect(dangerous).toBe(600);
  });
  test("all435 model services appear through fair seeded service bags at broad levels", () => {
    const stream = createQuestionStream(catalog, 88);
    stream.correct = 20;
    const services = new Set();
    for (let i = 0; i < 2000; i++) services.add(nextQuestion(stream).serviceId);
    expect(services.size).toBe(435);
  });
  test("same API can be normal or suspicious depending on visible approval", () => {
    const stream = createQuestionStream(catalog, 76);
    stream.correct = 10;
    const entries = [];
    for (let i = 0; i < 700; i++) {
      const q = nextQuestion(stream);
      if (q.operation === "StopLogging" && q.context.kind === "approval") entries.push(q);
    }
    expect(entries.some((q) => q.danger)).toBe(true);
    expect(entries.some((q) => !q.danger)).toBe(true);
    for (const q of entries) expect(q.danger).toBe(q.context.actual !== "承認あり");
  });
});

describe("levels, finite incoming stream and exact scoring", () => {
  test("earned correct detections advance levels at5,10,15,20 and speed is capped", () => {
    expect([0, 4, 5, 9, 10, 14, 15, 19, 20, 999].map(levelFor)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
    let previous = Infinity;
    for (let i = 0; i < 30; i++) {
      const d = difficulty(i);
      expect(d.fallMs).toBeLessThanOrEqual(previous);
      previous = d.fallMs;
      expect(d.fallMs).toBeGreaterThanOrEqual(10500);
    }
    expect(difficulty(999)).toEqual(difficulty(20));
  });
  test("round starts sparse, later objects arrive and any recognized upper item can be flagged", () => {
    let state = playing(0);
    for (let seed = 0; seed < 50; seed++) {
      const candidate = playing(seed);
      tick(candidate, 4801);
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
    const s = findOpening(true),
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
    const s = findOpening(true),
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
      candidate.correct = 10;
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
    expect(difficulty(20).intervalMs).toBeLessThan(difficulty(0).intervalMs);
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
    const s = findOpening(true),
      item = s.active[0];
    tick(s, item.deadline);
    const lives = s.lives;
    expect(collect(s, item.uid)).toBe(false);
    expect(s.lives).toBe(lives);
    expect(s.feedback.kind).toBe("miss");
  });
  test("double clicks and invalid IDs never score twice", () => {
    const s = findOpening(true),
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
