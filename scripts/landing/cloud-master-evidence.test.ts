import { describe, expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  INPUT_GUARD_MS,
  pause,
  resume,
  start,
  tick,
} from "../../landing/cloud-master/engine.js";
import { EVIDENCE_SCENARIOS } from "../../landing/cloud-master/evidence-scenarios.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
  violates,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const displayedValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
function expectExplanation(q: ReturnType<typeof nextQuestion>, reference: string, danger: boolean) {
  expect(q.danger).toBe(danger);
  expect(q.why).toStartWith(`今回の判断: ${danger ? "検知" : "通す"}。`);
  expect(q.why).toContain(`今回の観測: ${q.payload}。`);
  expect(q.why).toContain(`対象・用途: ${q.context.policy}。`);
  expect(q.why).toContain(`今回の値 ${displayedValue(q.context.actual)}`);
  expect(q.briefReason).toContain(displayedValue(q.context.actual));
  if (!danger) expect(q.briefReason).toContain("正常条件と整合");
  expect(q.why).toContain(danger ? "ため検知します" : "ため通します");
  if (!danger) expect(q.why).not.toContain("補足:");
  expect(new URL(q.source).hostname).toBe("docs.aws.amazon.com");
  expect(decodeURIComponent(new URL(q.source).hash)).toContain(reference);
}
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
    expect(ids.size).toBe(260);
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
  test("all520 explanations bind to the actual sampled observation and its normal or flagged decision", () => {
    let count = 0;
    for (const scenario of availableScenarios(catalog)) {
      const pair = [];
      for (const danger of [false, true]) {
        const stream = createQuestionStream(catalog, 91);
        stream.elapsed = 300000;
        stream.taughtLevel = LESSONS.length;
        stream.pressureIndex = 10;
        stream.scenarioTier = LESSONS.length;
        stream.scenarioBag = [scenario];
        stream.outcomes = [danger];
        const q = nextQuestion(stream);
        expectExplanation(q, scenario.referenceText ?? scenario.id, danger);
        pair.push(q);
        count++;
      }
      expect(pair[0].why).not.toBe(pair[1].why);
    }
    expect(count).toBe(520);
  });
  test("benign SDK values never inherit the dangerous pair explanation", () => {
    for (const [id, value, wrongText] of [
      ["EC2SecurityGroupPublicSSH", "RevokeSecurityGroupIngress", "新規許可"],
      ["RDSPubliclyAccessible", false, "外部に公開"],
      ["RDSIAMAuthDisabled", true, "認証を無効"],
    ]) {
      const scenario = availableScenarios(catalog).find((s) => s.id === id);
      const stream = createQuestionStream(catalog, 42);
      stream.elapsed = 300000;
      stream.taughtLevel = LESSONS.length;
      stream.pressureIndex = 10;
      stream.scenarioTier = LESSONS.length;
      stream.scenarioBag = [scenario];
      stream.outcomes = [false];
      const q = nextQuestion(stream);
      expect(q.context.actual).toBe(value);
      expect(q.why).toContain(`今回の値 ${value}`);
      expect(q.why).toContain("一致するため通します");
      expect(q.why).not.toContain(wrongText);
      expect(q.why).not.toContain(scenario.why);
    }
  });
  test("fresh seeds change sequence, same seed reproduces and adjacent questions never repeat", () => {
    const a = createQuestionStream(catalog, 102),
      b = createQuestionStream(catalog, 102),
      c = createQuestionStream(catalog, 103);
    a.taughtLevel = b.taughtLevel = c.taughtLevel = LESSONS.length;
    a.elapsed = b.elapsed = c.elapsed = 300000;
    c.taughtLevel = LESSONS.length;
    c.pressureIndex = 10;
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
    stream.elapsed = 300000;
    stream.taughtLevel = LESSONS.length;
    stream.pressureIndex = 10;
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
    s.elapsed = 300000;
    s.taughtLevel = LESSONS.length;
    s.pressureIndex = 10;
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
describe("tap-only detection and visual-only combo", () => {
  test("new objects become interactive at the100ms guard boundary", () => {
    const s = opening(true);
    const fresh = createGame(catalog, s.seed);
    start(fresh);
    tick(fresh, INPUT_GUARD_MS - 1);
    expect(collect(fresh, fresh.active[0].uid)).toBe(false);
    tick(fresh, 1);
    expect(collect(fresh, fresh.active[0].uid)).toBe(true);
  });
  test("normal fall scores10 once without increasing combo; tapping it costs one life", () => {
    const passive = opening(false);
    passive.combo = 2;
    const item = passive.active[0];
    tick(passive, item.deadline - passive.elapsed);
    expect(passive.history.filter((r) => r.uid === item.uid)).toHaveLength(1);
    expect(passive.history.find((r) => r.uid === item.uid).points).toBe(10);
    expect(passive.combo).toBe(2);
    const wrong = opening(false);
    wrong.combo = 2;
    expect(collect(wrong, wrong.active[0].uid)).toBe(true);
    expect(wrong.lives).toBe(2);
    expect(wrong.combo).toBe(0);
    expect(wrong.score).toBe(0);
  });
  test("correct taps alone grow combo; duplicate input and restart cannot inflate it", () => {
    const s = opening(true),
      uid = s.active[0].uid;
    expect(collect(s, uid)).toBe(true);
    expect(s.combo).toBe(1);
    expect(collect(s, uid)).toBe(false);
    expect(s.combo).toBe(1);
    expect(createGame(catalog, s.seed).combo).toBe(0);
  });
  test("pause and exact deadline cannot double-resolve a normal pass", () => {
    const s = opening(false),
      item = s.active[0];
    pause(s);
    expect(collect(s, item.uid)).toBe(false);
    resume(s);
    tick(s, item.deadline - s.elapsed);
    expect(collect(s, item.uid)).toBe(false);
    expect(s.history.filter((r) => r.uid === item.uid)).toHaveLength(1);
    expect(s.history.find((r) => r.uid === item.uid).points).toBe(10);
  });
});
