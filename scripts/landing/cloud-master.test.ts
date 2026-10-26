import { describe, expect, test } from "bun:test";
import {
  answer,
  choices,
  createGame,
  current,
  fallDuration,
  finish,
  next,
  pause,
  questions,
  resume,
  shuffled,
  start,
  tick,
} from "../../landing/cloud-master/engine.js";

describe("cloud master question bank", () => {
  test("20 unique scenarios, five roles and one valid answer with explanation", () => {
    expect(questions).toHaveLength(20);
    expect(new Set(questions.map((q) => q.title)).size).toBe(20);
    expect(new Set(questions.map((q) => q.id)).size).toBe(20);
    for (const q of questions) {
      expect(choices.filter((c) => c.id === q.answer)).toHaveLength(1);
      expect(q.prompt.length).toBeGreaterThan(25);
      expect(q.why.length).toBeGreaterThan(25);
    }
    for (const c of choices) expect(questions.filter((q) => q.answer === c.id)).toHaveLength(4);
  });
  test("seeded shuffle preserves every scenario and is reproducible", () => {
    expect(shuffled(726)).toEqual(shuffled(726));
    expect(shuffled(727)).not.toEqual(shuffled(726));
    expect(new Set(shuffled(726).map((q) => q.id)).size).toBe(20);
    expect(questions[0].id).toBe(0);
  });
});

describe("cloud master rules", () => {
  test("start guards, invalid answers and repeated clicks never double score", () => {
    const s = createGame();
    expect(answer(s, current(s).answer)).toBe(false);
    tick(s, 1000);
    expect(s.elapsed).toBe(0);
    start(s);
    expect(answer(s, "invalid")).toBe(false);
    expect(answer(s, current(s).answer)).toBe(true);
    expect(s.score).toBe(100);
    expect(answer(s, current(s).answer)).toBe(false);
    start(s);
    expect(s.score).toBe(100);
    expect(s.phase).toBe("feedback");
    expect(s.history).toHaveLength(1);
  });
  test("combos have capped bonuses; wrong answers reset chain and explain why", () => {
    const s = createGame();
    start(s);
    for (let i = 0; i < 8; i++) {
      answer(s, current(s).answer);
      next(s);
    }
    expect(s.score).toBe(1300);
    expect(s.combo).toBe(8);
    const wrong = choices.find((c) => c.id !== current(s).answer);
    answer(s, wrong.id);
    expect(s.combo).toBe(0);
    expect(s.best).toBe(8);
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.question.why.length).toBeGreaterThan(25);
    next(s);
    answer(s, current(s).answer);
    expect(s.feedback.points).toBe(100);
  });
  test("pause and feedback freeze clocks; resume preserves phase", () => {
    const s = createGame();
    start(s);
    tick(s, 1000);
    pause(s);
    pause(s);
    tick(s, 10000);
    expect(s.elapsed).toBe(1000);
    expect(s.fall).toBe(1000);
    expect(answer(s, current(s).answer)).toBe(false);
    resume(s);
    resume(s);
    answer(s, current(s).answer);
    pause(s);
    resume(s);
    expect(s.phase).toBe("feedback");
    tick(s, 10000);
    expect(s.elapsed).toBe(1000);
    next(s);
    expect(s.fall).toBe(0);
    tick(s, 500);
    expect(s.elapsed).toBe(1500);
  });
  test("missed cards resolve once with zero points and explanation", () => {
    const s = createGame();
    start(s);
    tick(s, fallDuration(s));
    expect(s.phase).toBe("feedback");
    expect(s.feedback.answer).toBeNull();
    expect(s.feedback.correct).toBe(false);
    tick(s, 10000);
    expect(s.history).toHaveLength(1);
    expect(s.score).toBe(0);
    next(s);
    expect(s.index).toBe(1);
    expect(s.fall).toBe(0);
  });
  test("timer completes at exactly 75 active seconds; expired card cannot score", () => {
    const s = createGame();
    start(s);
    for (let i = 0; i < 7; i++) {
      tick(s, 10000);
      answer(s, current(s).answer);
      next(s);
    }
    tick(s, 4999);
    expect(s.phase).toBe("playing");
    tick(s, 2);
    expect(s.elapsed).toBe(75000);
    expect(s.phase).toBe("finished");
    expect(answer(s, current(s).answer)).toBe(false);
    expect(s.history).toHaveLength(7);
    next(s);
    resume(s);
    expect(s.phase).toBe("finished");
  });
  test("learning has no clock; all 20 questions and fresh restart", () => {
    const s = createGame("learn");
    start(s);
    tick(s, 9999999);
    expect(s.elapsed).toBe(0);
    expect(s.fall).toBe(0);
    for (let i = 0; i < 20; i++) {
      answer(s, current(s).answer);
      if (i < 19) next(s);
    }
    finish(s);
    expect(s.phase).toBe("finished");
    expect(s.correct).toBe(20);
    const restarted = createGame("learn");
    expect(restarted.score).toBe(0);
    expect(restarted.history).toHaveLength(0);
    expect(current(restarted)).toEqual(s.deck[0]);
  });
  test("slow frames stop at the missed-card boundary like smaller frames", () => {
    const slow = createGame();
    const regular = createGame();
    start(slow);
    start(regular);
    tick(slow, 75000);
    tick(regular, 14000);
    tick(regular, 61000);
    expect(slow).toEqual(regular);
    expect(slow.elapsed).toBe(14000);
    expect(slow.phase).toBe("feedback");
  });
  test("invalid clock deltas cannot corrupt state", () => {
    const s = createGame();
    start(s);
    for (const delta of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) tick(s, delta);
    expect(s.elapsed).toBe(0);
    expect(s.phase).toBe("playing");
  });
});
