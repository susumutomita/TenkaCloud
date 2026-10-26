import { describe, expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  allow,
  collect,
  createGame,
  INPUT_GUARD_MS,
  next,
  pause,
  resume,
  start,
  tick,
} from "../../landing/cloud-master/engine.js";
import { EVIDENCE_SCENARIOS } from "../../landing/cloud-master/evidence-scenarios.js";
import { swipeDirection } from "../../landing/cloud-master/gestures.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
  violates,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function opening(danger: boolean) {
  for (let seed = 0; seed < 100; seed++) {
    const s = createGame(catalog, seed);
    start(s);
    if (s.active[0].question.danger === danger) {
      tick(s, 301);
      return s;
    }
  }
  throw Error("missing seed");
}
describe("all published defensive evidence", () => {
  test("every published index type and named runtime signal has a playable authored contrast", () => {
    const ids = new Set(availableScenarios(catalog).map((s) => s.id));
    expect(ids.size).toBe(253);
    for (const r of coverage.active) expect(ids.has(r.findingType)).toBe(true);
    for (const r of [...coverage.customSignals, ...coverage.runtimeCustomSignals])
      expect(ids.has(r.signalName)).toBe(true);
    expect(coverage.runtimeCustomSignals).toHaveLength(7);
    expect(coverage.runtimeCustomFindingTypes).toHaveLength(4);
    expect(EVIDENCE_SCENARIOS).toHaveLength(212);
  });
  test("every evidence normal counterexample and flagged case is unambiguous under visible game criteria", () => {
    const fixtures = new Set();
    for (const s of EVIDENCE_SCENARIOS) {
      expect(s.normal).not.toEqual(s.flag);
      const context = { kind: "evidence", operator: s.operator, threshold: s.threshold };
      expect(violates({ ...context, actual: s.normal })).toBe(false);
      expect(violates({ ...context, actual: s.flag })).toBe(true);
      expect(s.focusLabel.length).toBeGreaterThan(0);
      expect(s.baseline.length).toBeGreaterThan(12);
      expect(s.why.length).toBeGreaterThan(30);
      expect(s.source).toStartWith("https://docs.aws.amazon.com/guardduty/latest/ug/");
      expect(s.referenceText.length).toBeGreaterThan(4);
      fixtures.add(s.fixtureId);
    }
    expect(fixtures.size).toBe(212);
  });
  test("fresh seeds change sequence, same seed reproduces and adjacent questions never repeat", () => {
    const a = createQuestionStream(catalog, 102),
      b = createQuestionStream(catalog, 102),
      c = createQuestionStream(catalog, 103);
    a.elapsed = b.elapsed = c.elapsed = 120000;
    const sequence = [];
    const different = [];
    let previous = "";
    for (let i = 0; i < 1200; i++) {
      const q = nextQuestion(a);
      expect(q).toEqual(nextQuestion(b));
      expect(q.scenarioId).not.toBe(previous);
      previous = q.scenarioId;
      sequence.push(q.scenarioId + q.danger);
      different.push(nextQuestion(c).scenarioId);
    }
    expect(sequence.join()).not.toBe(different.join());
  });
  test("sampled indicators share address ranges and numeric thresholds remain visible", () => {
    const stream = createQuestionStream(catalog, 87);
    stream.elapsed = 120000;
    const flags = new Set(),
      normal = new Set();
    const groups = [normal, flags];
    let numeric = 0;
    for (let i = 0; i < 5000; i++) {
      const q = nextQuestion(stream);
      if (q.context.kind !== "evidence") continue;
      if (q.context.operator === "gt") {
        expect(q.context.policy).toContain(String(q.context.threshold));
        expect(q.danger).toBe(q.context.actual > q.context.threshold);
        numeric++;
      }
      if (
        typeof q.context.threshold === "string" &&
        /^203\.|^192\.|^198\./u.test(q.context.threshold)
      ) {
        expect(q.context.policy).toContain(q.context.threshold);
        groups[Number(q.danger)].add(String(q.context.actual).split(".").slice(0, 3).join("."));
      }
    }
    expect(numeric).toBeGreaterThan(50);
    expect(flags.size).toBe(3);
    expect(normal.size).toBe(3);
  });
  test("decision sources are specific official chapter references and every predicate field is visible", () => {
    const s = createQuestionStream(catalog, 62);
    s.elapsed = 120000;
    for (let i = 0; i < 1500; i++) {
      const q = nextQuestion(s);
      const url = new URL(q.source);
      expect(url.hostname).toBe("docs.aws.amazon.com");
      expect(url.hash).toStartWith("#:~:text=");
      expect(q.context.observed).toBe(q.payload);
      if (q.protocol.startsWith("synthetic-")) {
        expect(q.parameters).toEqual({});
        expect(q.wire).toContain("API要求ではありません");
        expect(q.fields[0][1]).toEqual(q.context.actual);
      }
    }
  });
  test("AI benign counterexample does not still report high-confidence prompt attack", () => {
    const q = EVIDENCE_SCENARIOS.find((s) => s.id === "Impact:IAMUser/PromptInjection.Direct");
    expect(q.extra.flat().join()).not.toContain("PROMPT_ATTACK");
    expect(q.normalExtra.flat().join()).toContain("confidence=NONE");
    expect(q.flagExtra.flat().join()).toContain("PROMPT_ATTACK / HIGH");
  });
  test("backup snapshot and AMI evidence links to its actual protection chapter", () => {
    for (const id of [
      "Execution:EC2/MaliciousFile!Snapshot",
      "Execution:EC2/MaliciousFile!AMI",
      "Execution:EC2/MaliciousFile!RecoveryPoint",
      "Execution:S3/MaliciousFile!RecoveryPoint",
    ]) {
      const q = EVIDENCE_SCENARIOS.find((s) => s.id === id);
      expect(q.source).toEndWith("/findings-malware-protection-backup.html");
    }
  });
  test("port sweep and port scan retain their documented directions", () => {
    const sweep = EVIDENCE_SCENARIOS.find((s) => s.id === "Impact:EC2/PortSweep");
    const scan = EVIDENCE_SCENARIOS.find((s) => s.id === "Recon:EC2/Portscan");
    expect(sweep.title).toContain("送信");
    expect(sweep.focusLabel).toBe("宛先IP台数");
    expect(scan.title).toContain("送信");
    expect(scan.focusLabel).toBe("宛先ポート種類");
  });
});
describe("manual allow, gesture intent and visual-only combo", () => {
  test("new objects become interactive at the100ms guard boundary", () => {
    const s = createGame(catalog, 8);
    start(s);
    tick(s, INPUT_GUARD_MS - 1);
    expect(collect(s, s.active[0].uid)).toBe(false);
    tick(s, 1);
    expect(
      s.active[0].question.danger ? collect(s, s.active[0].uid) : allow(s, s.active[0].uid),
    ).toBe(true);
    expect(INPUT_GUARD_MS).toBe(100);
  });
  test("allow normal gives10 once, manual combo increments, passive passage does not inflate it", () => {
    const s = opening(false),
      uid = s.active[0].uid;
    expect(allow(s, uid)).toBe(true);
    expect(s.score).toBe(10);
    expect(s.combo).toBe(1);
    expect(allow(s, uid)).toBe(false);
    expect(collect(s, uid)).toBe(false);
    expect(s.history).toHaveLength(1);
    const passive = opening(false);
    passive.combo = 2;
    tick(passive, passive.active[0].deadline - passive.elapsed);
    expect(passive.combo).toBe(2);
    expect(passive.score).toBe(10);
  });
  test("allow danger costs one life and freezes the actual-item explanation", () => {
    const s = opening(true),
      uid = s.active[0].uid;
    s.combo = 4;
    expect(allow(s, uid)).toBe(true);
    expect(s.lives).toBe(2);
    expect(s.combo).toBe(0);
    expect(s.score).toBe(0);
    expect(s.phase).toBe("feedback");
    expect(s.feedback.kind).toBe("allow-danger");
    const time = s.elapsed;
    tick(s, 999999);
    expect(s.elapsed).toBe(time);
    expect(allow(s, uid)).toBe(false);
    expect(s.lives).toBe(2);
    next(s);
    expect(s.phase).toBe("playing");
  });
  test("manual combo grows across both correct choices; mistakes and restart reset it", () => {
    const s = createGame(catalog, 3, true);
    start(s);
    for (let i = 0; i < 5; i++) {
      const q = s.active[0];
      if (q.question.danger) collect(s, q.uid);
      else allow(s, q.uid);
      expect(s.combo).toBe(i + 1);
      next(s);
    }
    const item = s.active[0];
    if (item.question.danger) allow(s, item.uid);
    else collect(s, item.uid);
    expect(s.combo).toBe(0);
    expect(createGame(catalog, 3).combo).toBe(0);
  });
  test("pause and exact deadline cannot double-resolve an allow", () => {
    const s = opening(false),
      item = s.active[0];
    pause(s);
    expect(allow(s, item.uid)).toBe(false);
    resume(s);
    tick(s, item.deadline - s.elapsed);
    expect(allow(s, item.uid)).toBe(false);
    expect(s.history.filter((r) => r.uid === item.uid)).toHaveLength(1);
    expect(s.history.find((r) => r.uid === item.uid).points).toBe(10);
  });
  test("horizontal threshold rejects cancelled, short, diagonal and vertical gestures", () => {
    expect(swipeDirection({ dx: -60, dy: 5, elapsed: 200 })).toBe("stop");
    expect(swipeDirection({ dx: 60, dy: 5, elapsed: 200 })).toBe("allow");
    expect(swipeDirection({ dx: 32, dy: 2, elapsed: 40 })).toBe("allow");
    for (const data of [
      { dx: 20, dy: 0, elapsed: 10 },
      { dx: 45, dy: 40, elapsed: 80 },
      { dx: 0, dy: 90, elapsed: 90 },
      { dx: 80, dy: 0, elapsed: 100, cancelled: true },
      { dx: 35, dy: 0, elapsed: 300 },
    ])
      expect(swipeDirection(data)).toBe(null);
  });
});
