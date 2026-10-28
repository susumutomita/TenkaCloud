import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
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
  s.correct = 10;
  s.level = 2;
  s.lessonNotice = {
    level: 2,
    shownAt: null,
    visible: false,
    readRemaining: LESSON_NOTICE_MS,
    graceRemaining: LESSON_GRACE_MS,
  };
  return s;
}
function generate(id: string, danger: boolean) {
  const stream = createQuestionStream(catalog, 38);
  Object.assign(stream, {
    elapsed: 300000,
    taughtLevel: LESSONS.length,
    scenarioTier: LESSONS.length,
    scenarioBag: [availableScenarios(catalog).find((s) => s.id === id)],
    outcomes: [danger],
  });
  return nextQuestion(stream);
}
test("all normal and flagged cases have exactly one introduction and cumulative pool", () => {
  const ids = LESSONS.flatMap((l) => l.scenarios);
  expect(ids.length).toBe(260);
  expect(new Set(ids).size).toBe(260);
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
test("opening has EC2 lifecycle variety and early actor threats without network prerequisites", () => {
  expect(LESSONS.slice(0, 7).map((l) => l.id)).toEqual([
    "ec2",
    "early-threats",
    "rds",
    "alb",
    "app-path",
    "delivery",
    "waf",
  ]);
  expect(LESSONS[0].scenarios).toHaveLength(3);
  for (const source of availableAtLevel(catalog, 2))
    for (const danger of [false, true]) {
      const q = generate(source.id, danger);
      for (const lang of ["ja", "en"]) {
        const view = questionView(q, lang);
        expect(`${view.policy} ${view.payload}`).not.toMatch(
          /CIDR|\bSSH\b|\bSG\b|ポート|セキュリティグループ|security group|\bport\b/i,
        );
      }
    }
  expect(LESSONS[1].scenarios.every((id) => id.includes("IAMUser/AnomalousBehavior"))).toBe(true);
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
test("the introductory pool blocks active duplicates and waits without consuming an outcome", () => {
  const s = game();
  s.active = [];
  for (const source of availableAtLevel(catalog, 1))
    for (const danger of [false, true])
      s.active.push({
        uid: s.active.length,
        born: 0,
        deadline: 14000,
        question: generate(source.id, danger),
      });
  const outcomes = [...s.outcomes],
    turn = s.practiceTurn;
  expect(nextQuestion(s)).toBe(null);
  expect(s.outcomes).toEqual(outcomes);
  expect(s.practiceTurn).toBe(turn);
  s.history = s.active.map((x) => ({ question: x.question, at: 0 }));
  s.active = [];
  s.elapsed = 7999;
  expect(nextQuestion(s)).not.toBe(null);
  s.elapsed = 8000;
  expect(nextQuestion(s)).not.toBe(null);
});
test("clock alone does not introduce a rule and earned notices cannot skip unseen lessons", () => {
  const s = game();
  s.active = [];
  s.nextSpawnAt = Infinity;
  tick(s, 300000);
  expect(s.level).toBe(1);
  expect(s.lessonNotice).toBe(null);
  expect(s.taughtLevel).toBe(1);
  pending(s);
  tickFrame(s, 20000);
  expect(s.lessonNotice.shownAt).toBe(null);
  expect(s.taughtLevel).toBe(1);
  showLesson(s);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonNotice).toBe(null);
});
test("paint acknowledgment and finite reading precede new-rule admission without blocking old cards", () => {
  const s = pending();
  const old = s.active[0];
  expect(showLesson(s)).toBe(true);
  expect(s.taughtLevel).toBe(1);
  const at = s.elapsed;
  tickFrame(s, 100000);
  expect(s.elapsed - at).toBe(100);
  expect(old.deadline).toBe(14000);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS - 101);
  expect(s.taughtLevel).toBe(1);
  tick(s, 1);
  expect(s.lessonNotice).toBe(null);
  expect(s.taughtLevel).toBe(2);
  expect(s.active.every((x) => x.question.lessonLevel <= 2)).toBe(true);
});
test("reading survives pause and acknowledgment never extends existing card deadlines", () => {
  const s = pending();
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
  expect(old.decisionDeadline).toBeUndefined();
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
test("enough correct decisions unlock all cases without skips or a forced ending", () => {
  for (const capacity of [1, 2, 3, 6]) {
    const s = game(capacity),
      visited = new Set([1]);
    s.maxCards = capacity;
    for (let step = 0; step < 60000 && s.taughtLevel < LESSONS.length; step++) {
      tickFrame(s, 50);
      if (s.lessonNotice && s.lessonNotice.shownAt === null) {
        expect(s.lessonNotice.level).toBe(s.taughtLevel + 1);
        showLesson(s);
        visited.add(s.lessonNotice.level);
      }
      for (const item of [...s.active]) {
        expect(item.question.lessonLevel).toBeLessThanOrEqual(s.taughtLevel);
        if (item.question.danger) collect(s, item.uid);
      }
      expect(s.phase).not.toBe("feedback");
    }
    expect(s.lives).toBe(3);
    expect(s.taughtLevel).toBe(LESSONS.length);
    expect(visited.size).toBe(LESSONS.length);
    expect(s.elapsed).toBeGreaterThan(300000);
    expect(s.phase).not.toBe("finished");
    expect(new Set(s.history.map((h) => h.uid)).size).toBe(s.history.length);
    expect(s.score).toBe(s.history.reduce((sum, h) => sum + h.points, 0));
  }
});
