import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  ALL_RULES_AT,
  FIRST_LESSON_MS,
  LESSON_GRACE_MS,
  LESSON_NOTICE_MS,
  LESSONS,
  scenarioLevel,
} from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  next,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { loadQuestionLocale, questionView } from "../../landing/cloud-master/question-locales.js";
import {
  availableAtLevel,
  availableScenarios,
  createQuestionStream,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
await loadQuestionLocale("en");
function game(seed = 12, level = 1) {
  const s = createGame(catalog, seed);
  start(s);
  if (level > 1) {
    s.taughtLevel = level;
    s.active = [];
    s.scenarioTier = 0;
    s.nextSpawnAt = 1;
    tick(s, 2);
  }
  return s;
}
function pending(s = game()) {
  s.active = [];
  s.lessonStats = { normal: 2, danger: 2 };
  s.nextLessonAt = s.elapsed + 1;
  tick(s, 1);
  expect(s.lessonNotice.level).toBe(s.taughtLevel + 1);
  return s;
}
function generate(id: string, danger: boolean) {
  const stream = createQuestionStream(catalog, 38);
  Object.assign(stream, {
    elapsed: ALL_RULES_AT,
    scenarioTier: LESSONS.length,
    scenarioBag: [availableScenarios(catalog).find((s) => s.id === id)],
    outcomes: [danger],
  });
  return nextQuestion(stream);
}
test("all normal and flagged cases have exactly one introduction and cumulative pool", () => {
  const ids = LESSONS.flatMap((l) => l.scenarios);
  expect(ids.length).toBe(259);
  expect(new Set(ids).size).toBe(259);
  expect(new Set(ids)).toEqual(new Set(availableScenarios(catalog).map((s) => s.id)));
  expect(() => scenarioLevel("missing-case")).toThrow();
  for (let level = 1; level <= LESSONS.length; level++) {
    const lesson = LESSONS[level - 1];
    for (const key of ["title", "example", "enTitle", "enExample"])
      expect(lesson[key].length).toBeGreaterThan(5);
    expect(
      availableAtLevel(catalog, level)
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      LESSONS.slice(0, level)
        .flatMap((l) => l.scenarios)
        .sort(),
    );
    for (const id of lesson.scenarios)
      for (const danger of [false, true]) {
        const q = generate(id, danger);
        expect(q.lessonLevel).toBe(level);
        expect(q.danger).toBe(danger);
        for (const lang of ["ja", "en"])
          expect(questionView(q, lang).policy.length).toBeGreaterThan(10);
      }
  }
});
test("EC2 then RDS need only stated target policy without network or identity prerequisites", () => {
  expect(LESSONS.slice(0, 6).map((l) => l.id)).toEqual([
    "ec2",
    "rds",
    "alb",
    "app-path",
    "delivery",
    "waf",
  ]);
  for (const level of [1, 2])
    for (const source of availableAtLevel(catalog, level))
      for (const danger of [false, true]) {
        const q = generate(source.id, danger);
        expect(["StopInstances", "StopDBInstance"]).toContain(q.operation);
        for (const lang of ["ja", "en"]) {
          const view = questionView(q, lang);
          expect(`${view.policy} ${view.payload}`).not.toMatch(
            /CIDR|\bIAM\b|\bSSH\b|\bSG\b|ポート|セキュリティグループ|security group|\bport\b/i,
          );
          expect(view.payload).toMatch(/i-training|i-app-running|training-db|orders-db/);
        }
      }
});
test("sampler has no future rules, reserves current practice, stays balanced and seeded", () => {
  for (let level = 1; level <= LESSONS.length; level++) {
    const a = game(19, level),
      b = game(19, level);
    a.active = b.active = [];
    a.outcomes = [];
    b.outcomes = [];
    let danger = 0,
      introduced = 0;
    const seen = new Set();
    for (let i = 0; i < 1200; i++) {
      const q = nextQuestion(a);
      expect(q).toEqual(nextQuestion(b));
      expect(q.lessonLevel).toBeLessThanOrEqual(level);
      introduced += Number(q.lessonLevel === level);
      danger += Number(q.danger);
      seen.add(q.scenarioId);
    }
    expect(danger).toBe(600);
    expect(introduced).toBeGreaterThanOrEqual(600);
    expect(seen.size).toBe(availableAtLevel(catalog, level).length);
  }
  const orders = new Set(
    Array.from({ length: 12 }, (_, seed) => {
      const s = game(seed, 3);
      s.active = [];
      return Array.from({ length: 12 }, () => {
        const q = nextQuestion(s);
        return `${q.scenarioId}:${q.danger}`;
      }).join();
    }),
  );
  expect(orders.size).toBeGreaterThan(8);
});
test("small lessons block active duplicate decisions and preserve unavailable practice reservation", () => {
  const s = game(),
    first = s.active[0].question,
    other = nextQuestion(s);
  expect(other.danger).not.toBe(first.danger);
  s.active.push({ uid: 999, born: 0, deadline: 16000, question: other });
  const outcomes = [...s.outcomes],
    turn = s.practiceTurn;
  expect(nextQuestion(s)).toBe(null);
  expect(s.outcomes).toEqual(outcomes);
  expect(s.practiceTurn).toBe(turn);
  s.active = [];
  s.history = [first, other].map((question) => ({ question, at: 0 }));
  s.elapsed = 1999;
  expect(nextQuestion(s)).toBe(null);
  s.elapsed = 2000;
  expect(nextQuestion(s)).not.toBe(null);
});
test("time alone cannot advance any lesson including the final correlation lesson", () => {
  for (const level of [1, LESSONS.length]) {
    const s = game(12, level);
    s.active = [];
    s.nextSpawnAt = Infinity;
    tick(s, FIRST_LESSON_MS + 10000);
    expect(s.lessonNotice).toBe(null);
    expect(s.taughtLevel).toBe(level);
    s.lessonStats = { normal: 2, danger: 1 };
    tick(s, 1);
    expect(s.lessonNotice).toBe(null);
    s.lessonStats.danger = 2;
    tick(s, 1);
    expect(s.lessonNotice.level).toBe(level + 1);
    expect(s.taughtLevel).toBe(level);
    tickFrame(s, 20000);
    expect(s.lessonNotice.shownAt).toBe(null);
    expect(s.active).toHaveLength(0);
  }
});
test("paint acknowledgment plus finite reading and grace precede every new-rule card", () => {
  const s = pending();
  expect(showLesson(s)).toBe(true);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonStats).toEqual({ normal: 0, danger: 0 });
  const at = s.elapsed;
  tickFrame(s, 100000);
  expect(s.elapsed - at).toBe(100);
  expect(s.active).toHaveLength(0);
  expect(s.lessonNotice.readRemaining).toBe(LESSON_NOTICE_MS - 100);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS - 101);
  expect(s.active).toHaveLength(0);
  tick(s, 1);
  expect(s.lessonNotice).toBe(null);
  expect(s.active).toHaveLength(1);
  expect(s.active[0].question.scenarioId).toBe("RDSApprovedStop");
  expect(s.active[0].deadline - s.active[0].born).toBe(16000);
});
test("read budget and card identity survive pause, repeated acknowledgment and stale input", () => {
  const s = game();
  s.active[0].deadline = 10000;
  s.lessonStats = { normal: 2, danger: 2 };
  s.nextLessonAt = 1;
  tick(s, 1);
  const old = s.active[0],
    identity = { uid: old.uid, born: old.born, deadline: old.deadline };
  showLesson(s);
  tick(s, 500);
  const budget = s.lessonNotice.readRemaining;
  pause(s);
  tick(s, 100000);
  expect(showLesson(s)).toBe(false);
  expect(s.lessonNotice.readRemaining).toBe(budget);
  resume(s);
  showLesson(s);
  showLesson(s);
  expect(s.lessonNotice.readRemaining).toBe(budget);
  expect({ uid: old.uid, born: old.born, deadline: old.deadline }).toEqual(identity);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS - 500);
  expect(old.decisionDeadline).toBe(old.deadline + LESSON_NOTICE_MS + LESSON_GRACE_MS);
  expect(s.lessonNotice).toBe(null);
  expect(collect(s, 999999)).toBe(false);
  expect(s.history).toHaveLength(0);
});
test("mistakes require explicit continue and never count as learned contrast", () => {
  let s = game();
  for (let seed = 0; seed < 10; seed++) {
    const candidate = game(seed);
    if (!candidate.active[0].question.danger) {
      s = candidate;
      break;
    }
  }
  tick(s, 100);
  const item = s.active[0];
  collect(s, item.uid);
  expect(s.phase).toBe("feedback");
  expect(s.lessonStats).toEqual({ normal: 0, danger: 0 });
  const before = s.elapsed;
  tick(s, 100000);
  expect(s.elapsed).toBe(before);
  next(s);
  expect(collect(s, item.uid)).toBe(false);
  expect(s.lives).toBe(2);
});
test("new API observations agree with request members and verified target labels", () => {
  for (const danger of [false, true]) {
    const alb = generate("ALBApprovedForwardTarget", danger);
    expect(alb.parameters.DefaultActions[0].TargetGroupArn).toContain(
      `targetgroup/${alb.context.actual}/`,
    );
    const sg = generate("SecurityGroupAppSource", danger);
    expect(sg.parameters.IpPermissions[0].UserIdGroupPairs[0].GroupId).toBe(sg.context.actual);
    expect(sg.parameters.IpPermissions[0].FromPort).toBe(8080);
    const cf = generate("CloudFrontApprovedOrigin", danger);
    expect(cf.parameters.DistributionConfig.Origins.Items[0].DomainName).toBe(cf.context.actual);
    const waf = generate("WAFEnforcedBlock", danger);
    expect(waf.parameters.Rules[0].Action).toEqual(waf.context.actual);
    expect(waf.parameters.Rules[0]).not.toHaveProperty("OverrideAction");
  }
});
test("perfect play reaches every taught lesson at narrow and wide capacities without skips", () => {
  for (const capacity of [2, 3, 6]) {
    const s = game(capacity),
      visited = new Set([1]);
    s.maxCards = capacity;
    for (let step = 0; step < 20000 && s.taughtLevel <= LESSONS.length; step++) {
      tickFrame(s, 100);
      if (s.lessonNotice && s.lessonNotice.shownAt === null) {
        expect(s.lessonStats.normal).toBeGreaterThanOrEqual(2);
        expect(s.lessonStats.danger).toBeGreaterThanOrEqual(2);
        showLesson(s);
        visited.add(s.taughtLevel);
      }
      for (const item of [...s.active]) {
        expect(item.question.lessonLevel).toBeLessThanOrEqual(s.taughtLevel);
        if (item.question.danger) collect(s, item.uid);
      }
      expect(s.phase).not.toBe("feedback");
    }
    expect(s.lives).toBe(3);
    expect(s.taughtLevel).toBe(LESSONS.length + 1);
    expect(visited.size).toBe(LESSONS.length + 1);
    expect(new Set(s.history.map((h) => h.uid)).size).toBe(s.history.length);
    expect(s.score).toBe(s.history.reduce((sum, h) => sum + h.points, 0));
  }
});
