import { describe, expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  next,
  showLesson,
  start,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { explanationCard } from "../../landing/cloud-master/explanation.js";
import {
  availableAtLevel,
  availableScenarios,
  createQuestionStream,
  difficulty,
  LEVEL_STAGES,
  levelFor,
  nextQuestion,
  QUESTION_COOLDOWN_MS,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const identity = (s) =>
  s.active.map((x) => ({ uid: x.uid, born: x.born, deadline: x.deadline, id: x.question.id }));

const decisionKey = (q: ReturnType<typeof nextQuestion>) => `${q.scenarioId}:${q.danger}`;
function newBirths(s: ReturnType<typeof createGame>, seen: Set<number>) {
  let count = 0;
  for (const item of s.active) {
    if (seen.has(item.uid)) continue;
    seen.add(item.uid);
    count++;
    const key = decisionKey(item.question);
    expect(s.active.filter((a) => decisionKey(a.question) === key)).toHaveLength(1);
    expect(
      s.history.some(
        (h) => s.elapsed - h.at < QUESTION_COOLDOWN_MS && decisionKey(h.question) === key,
      ),
    ).toBe(false);
  }
  return count;
}
function perfectStep(s: ReturnType<typeof createGame>) {
  if (s.phase === "feedback") next(s);
  if (s.lessonNotice) showLesson(s);
  if (s.phase === "finished") return false;
  if (s.phase === "playing")
    for (const item of [...s.active])
      if (item.question.danger && s.elapsed - item.born >= 100) collect(s, item.uid);
  return true;
}
function sampleFreshGame(seed: number) {
  const s = createGame(catalog, seed);
  s.elapsed = 300000;
  s.taughtLevel = LESSONS.length;
  s.pressureIndex = 10;
  start(s);
  const seen = new Set<number>();
  let count = 0;
  for (let i = 0; i < 600; i++) {
    tickFrame(s, 100);
    count += newBirths(s, seen);
    if (!perfectStep(s)) break;
  }
  return count;
}
function generatedCase(source: ReturnType<typeof availableScenarios>[number], danger: boolean) {
  const stream = createQuestionStream(catalog, 37);
  stream.elapsed = 300000;
  stream.taughtLevel = LESSONS.length;
  stream.pressureIndex = 10;
  stream.scenarioTier = LESSONS.length;
  stream.scenarioBag = [source];
  stream.outcomes = [danger];
  return nextQuestion(stream);
}
const displayedValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
function checkExplanation(q: ReturnType<typeof nextQuestion>, danger: boolean) {
  const v = explanationCard(q);
  expect(v.actual).toBe(displayedValue(q.context.actual));
  expect(v.fullReason).toBe(q.why);
  expect(v.source).toBe(q.source);
  expect(v.headline.length).toBeGreaterThan(5);
  expect(v.expected).not.toBeUndefined();
  if (!danger) {
    expect(v.danger).toBe(false);
    expect(v.fullReason).toContain("ため通します");
  }
  if (q.scenarioId === "Policy:S3/BucketPublicAccessGranted" && danger) checkBucket(v);
}
function checkBucket(v: ReturnType<typeof explanationCard>) {
  expect(v.headline).toContain("一覧");
  expect(v.expected).toBe("private");
  expect(v.actual).toBe("public-read");
  expect(v.reason).toContain("ファイル内容の公開とは別");
  expect(v.fullReason).toContain("オブジェクト内容の公開とは別");
  expect(v.fullReason).toContain("他の保護設定");
}

describe("visible frame admission and resume ledger", () => {
  test("one delayed rendered frame admits at most one fresh card, with a future next cadence", () => {
    const s = createGame(catalog, 3);
    s.outcomes = Array(100).fill(false);
    start(s);
    tickFrame(s, 1601);
    expect(s.active).toHaveLength(2);
    const untouched = identity(s),
      serial = s.serial;
    tickFrame(s, 5000);
    expect(s.serial - serial).toBe(1);
    expect(identity(s).slice(0, 2)).toEqual(untouched);
    expect(s.active.at(-1).born).toBe(s.elapsed);
    expect(s.nextSpawnAt).toBe(s.elapsed + difficulty(s.taughtLevel, s.pressureIndex).intervalMs);
    tickFrame(s, 16);
    expect(s.serial - serial).toBe(1);
    expect(s.score).toBe(0);
  });
  test("existing physical deadlines and normal pass scoring survive long renderer gaps", () => {
    const s = createGame(catalog, 3);
    s.elapsed = 300000;
    s.taughtLevel = LESSONS.length;
    s.pressureIndex = 10;
    s.outcomes = Array(100).fill(false);
    start(s);
    const first = s.active[0];
    tickFrame(s, first.deadline - s.elapsed + 500);
    expect(s.history.filter((x) => x.uid === first.uid)).toHaveLength(1);
    expect(s.score).toBe(10);
    expect(s.active.some((x) => x.uid === first.uid)).toBe(false);
    expect(s.active).toHaveLength(1);
    expect(s.active[0].born).toBe(s.elapsed);
    expect(collect(s, first.uid)).toBe(false);
  });
  test("an empty field can recycle an eligible known case without inventing an untaught case", () => {
    const s = createGame(catalog, 3);
    s.outcomes = [true];
    s.history = availableAtLevel(catalog, 1).map((source) => ({
      at: 0,
      question: { scenarioId: source.id, danger: true },
    }));
    expect(nextQuestion(s).lessonLevel).toBe(1);
    expect(s.outcomes).toEqual([]);
    expect(s.questionSerial).toBe(1);
    s.elapsed = QUESTION_COOLDOWN_MS;
    expect(nextQuestion(s)).not.toBe(null);
    expect(s.questionSerial).toBe(2);
  });
  test("multiple misses preserve untouched identities, RNG/history/serial and score; gameover restart resets only new round", () => {
    const s = createGame(catalog, 49);
    start(s);
    const resolved = new Set();
    let resumes = 0;
    for (let i = 0; i < 2000 && s.phase !== "finished"; i++) {
      if (s.lessonNotice) showLesson(s);
      tickFrame(s, 200);
      for (const x of s.history) {
        resolved.add(x.uid);
        expect(s.active.some((a) => a.uid === x.uid)).toBe(false);
      }
      expect(s.history.length).toBe(new Set(s.history.map((x) => x.uid)).size);
      expect(s.score).toBe(s.history.reduce((n, x) => n + x.points, 0));
      if (s.phase !== "feedback") continue;
      const before = identity(s),
        rng = s.rng,
        serial = s.serial,
        history = [...s.history],
        score = s.score;
      next(s);
      expect(identity(s)).toEqual(before);
      expect(s.rng).toBe(rng);
      expect(s.serial).toBe(serial);
      expect(s.history).toEqual(history);
      expect(s.score).toBe(score);
      resumes++;
    }
    expect(resumes).toBeGreaterThanOrEqual(3);
    expect(s.phase).toBe("finished");
    expect(s.lives).toBe(0);
    const fresh = createGame(catalog, 49);
    start(fresh);
    expect(fresh.active[0].uid).toBe(0);
    expect(fresh.history).toEqual([]);
    expect(fresh.score).toBe(0);
    expect(resolved.size).toBe(s.history.length);
  });
  test("no same decision case while active or within8seconds of completion", () => {
    let births = 0;
    for (let seed = 0; seed < 50; seed++) births += sampleFreshGame(seed);
    expect(births).toBeGreaterThan(1000);
  });
});
describe("discrete stages and compact evidence explanations", () => {
  test("each announced stage expands the cumulative pool", () => {
    let size = 0;
    for (let i = 0; i < LEVEL_STAGES.length; i++) {
      const t = LEVEL_STAGES[i].correct,
        d = difficulty(levelFor(t));
      expect(d.level).toBe(i + 1);
      if (i) expect(levelFor(t - 1)).toBe(i);
      expect(d.fallMs).toBeGreaterThanOrEqual(4200);
      const pool = availableAtLevel(catalog, i + 1);
      expect(pool.length).toBeGreaterThan(size);
      size = pool.length;
    }
    expect(size).toBe(260);
  });
  test("elapsed time alone cannot introduce an unseen rule or replace existing identities", () => {
    const s = createGame(catalog, 3);
    start(s);
    const before = identity(s);
    tickFrame(s, 32);
    expect(s.elapsed).toBe(32);
    expect(s.taughtLevel).toBe(1);
    expect(identity(s)).toEqual(before);
  });
  test("all520 concise explanations preserve actual case and full official evidence", () => {
    for (const source of availableScenarios(catalog))
      for (const danger of [false, true]) checkExplanation(generatedCase(source, danger), danger);
  });
});
