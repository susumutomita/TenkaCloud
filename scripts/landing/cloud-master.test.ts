import { describe, expect, test } from "bun:test";
import {
  collect,
  createGame,
  finish,
  next,
  passStudy,
  pause,
  resume,
  start,
  tick,
} from "../../landing/cloud-master/engine.js";
import { choices, questions, templates } from "../../landing/cloud-master/questions.js";
import { buildDeck, objective } from "../../landing/cloud-master/recognition.js";

describe("authored conditions and protocol semantics", () => {
  test("six families have five distinct condition/answer variants, never random relabeling", () => {
    expect(questions).toHaveLength(30);
    expect(new Set(questions.map((q) => q.id)).size).toBe(30);
    for (const template of templates)
      for (const choice of choices) {
        const question = questions.find((q) => q.id === `${template.id}:${choice.id}`);
        expect(question.answer).toBe(choice.id);
        expect(question.prompt).toBe(template.variants[choice.id][0]);
        expect(question.why.length).toBeGreaterThan(25);
      }
  });
  test("seeded decks preserve conditions and balance all non-target categories", () => {
    for (const seed of [0, 1, 2, 3, 4, 726, 999]) {
      const target = objective("foundation", seed);
      const deck = buildDeck("foundation", seed);
      expect(deck).toEqual(buildDeck("foundation", seed));
      expect(deck).not.toEqual(buildDeck("foundation", seed + 5));
      expect(deck.filter((q) => q.match)).toHaveLength(24);
      expect(new Set(deck.filter((q) => !q.match).map((q) => q.category)).size).toBe(4);
      for (const q of deck) expect(q.match).toBe(q.answer === target.id);
      for (let i = 1; i < deck.length; i++) expect(deck[i].id).not.toBe(deck[i - 1].id);
    }
  });
  test("HTTP requests differ from responses; TLS and port 443 are not proof", () => {
    const deck = buildDeck("http", 123);
    for (const q of deck) {
      if (q.match) {
        expect(q.prompt).toMatch(
          /^(GET|HEAD|POST|PUT) \/[^ ]+ HTTP\/1\.1\r\nHost: practice\.invalid\r\n/u,
        );
        if (q.prompt.includes("Content-Length:")) {
          const [headers, body] = q.prompt.split("\r\n\r\n");
          expect(Number(headers.match(/Content-Length: (\d+)/u)[1])).toBe(body.length);
        }
      } else expect(q.category).not.toBe("request");
    }
    for (const category of ["response", "opaque", "transport", "smtp", "dns"])
      expect(deck.some((q) => q.category === category && !q.match)).toBe(true);
  });
  test("AWS operation plus DryRun decides meaning; request is not a success response", () => {
    const deck = buildDeck("aws", 42);
    for (const q of deck) {
      expect(q.match).toBe(q.operation === "StartInstances" && q.parameters.DryRun === false);
      expect(q.prompt).toContain(`DryRun=${q.parameters.DryRun}`);
      expect(q.parameters["InstanceId.1"]).toMatch(/^i-[0-9a-f]{17}$/u);
      expect(q.source).toContain(`API_${q.operation}.html`);
    }
    expect(deck.some((q) => q.operation === "StartInstances" && !q.match)).toBe(true);
    expect(deck.find((q) => q.match).why).toContain("成功したか");
  });
});

describe("survival rules and input hazards", () => {
  function playing(mode = "foundation", seed = 726) {
    const s = createGame(mode, seed);
    start(s);
    return s;
  }
  test("three simultaneous objects, newest can be taken before oldest", () => {
    const s = playing();
    expect(s.active).toHaveLength(3);
    const target = s.active.filter((q) => q.question.match).at(-1);
    expect(collect(s, target.uid)).toBe(true);
    expect(s.phase).toBe("playing");
    expect(s.score).toBe(100);
    expect(s.active).toHaveLength(3);
    expect(s.history[0].uid).toBe(target.uid);
  });
  test("double tap, detached old target, invalid target and held repeats cannot score twice", () => {
    const s = playing();
    const item = s.active.find((q) => q.question.match);
    expect(collect(s, item.uid)).toBe(true);
    expect(collect(s, item.uid)).toBe(false);
    expect(collect(s, 999999)).toBe(false);
    expect(s.score).toBe(100);
    expect(s.history).toHaveLength(1);
    const replacement = s.active.find((q) => q.slot === item.slot);
    expect(collect(s, replacement.uid)).toBe(false);
  });
  test("wrong pick costs one life, continues, and records actual mistake", () => {
    const s = playing("http");
    const other = s.active.find((q) => !q.question.match);
    expect(collect(s, other.uid)).toBe(true);
    expect(s.phase).toBe("playing");
    expect(s.lives).toBe(2);
    expect(s.score).toBe(0);
    expect(s.feedback.kind).toBe("wrong");
    expect(s.feedback.question).toEqual(other.question);
    expect(collect(s, other.uid)).toBe(false);
    expect(s.history).toHaveLength(1);
  });
  test("nonmatches pass harmlessly; required target misses freeze for explanation", () => {
    const s = playing();
    const target = s.active.find((q) => q.question.match);
    const earliest = Math.min(...s.active.map((q) => q.deadline));
    const first = s.active.find((q) => q.deadline === earliest);
    if (first.question.match) {
      tick(s, earliest);
      expect(s.feedback.kind).toBe("miss");
      expect(s.feedback.picked).toBeNull();
    } else {
      tick(s, earliest);
      expect(s.phase).toBe("playing");
      expect(s.passed).toBe(1);
      expect(s.score).toBe(0);
      tick(s, target.deadline - s.elapsed);
      expect(s.feedback.kind).toBe("miss");
    }
  });
  test("expired card cannot be scored after a delayed event", () => {
    const s = playing();
    const target = s.active.find((q) => q.question.match);
    tick(s, target.deadline + 1);
    expect(collect(s, target.uid)).toBe(false);
    expect(s.feedback.kind).toBe("miss");
    expect(s.score).toBe(0);
  });
  test("pause freezes all positions; wrong-key pick while paused cannot end a round", () => {
    const s = playing();
    tick(s, 1000);
    pause(s);
    pause(s);
    tick(s, 999999);
    expect(s.elapsed).toBe(1000);
    expect(collect(s, s.active[0].uid)).toBe(false);
    resume(s);
    resume(s);
    expect(s.phase).toBe("playing");
    tick(s, 500);
    expect(s.elapsed).toBe(1500);
  });
  test("large and small frames freeze at the same first miss", () => {
    const a = playing("http", 55),
      b = playing("http", 55);
    tick(a, 100000);
    for (let i = 0; i < 100; i++) tick(b, 1000);
    expect(a).toEqual(b);
    expect(a.feedback.kind).toBe("miss");
  });
  test("continuous stream has no fixed timer, avoids immediate repeats across cycles", () => {
    const s = playing("aws");
    const seen = [];
    for (let i = 0; i < 300; i++) {
      tick(s, 301);
      const matches = s.active.filter((item) => item.question.match);
      for (const item of matches) {
        collect(s, item.uid);
        seen.push(item.question.id);
      }
      for (const item of s.active.filter((item) => !item.question.match))
        item.deadline = s.elapsed + 1;
      tick(s, 1);
    }
    expect(s.phase).toBe("playing");
    expect(s.cycle).toBeGreaterThan(0);
    expect(s.elapsed).toBeGreaterThan(75000);
    expect(s.correct).toBeGreaterThan(30);
    expect(s.history.every((entry) => entry.correct)).toBe(true);
    expect(seen.length).toBe(s.correct);
  });
  test("untimed study accepts pick/pass, explains errors and continues", () => {
    const s = createGame("aws", 4, true);
    start(s);
    tick(s, 1000000);
    expect(s.elapsed).toBe(0);
    const q = s.active[0];
    if (q.question.match) collect(s, q.uid);
    else passStudy(s);
    expect(s.phase).toBe("feedback");
    expect(s.feedback.correct).toBe(true);
    pause(s);
    resume(s);
    expect(s.phase).toBe("feedback");
    next(s);
    expect(s.phase).toBe("playing");
    finish(s);
    expect(s.end.reason).toBe("manual");
  });
  test("miss freezes every clock until acknowledgment; final life explains before result", () => {
    const s = playing("http", 123);
    for (let mistake = 0; mistake < 3; mistake++) {
      tick(s, 100000);
      expect(s.phase).toBe("feedback");
      const snapshot = JSON.stringify(s);
      tick(s, 999999);
      expect(JSON.stringify(s)).toBe(snapshot);
      expect(s.lives).toBe(2 - mistake);
      next(s);
      expect(s.phase).toBe(mistake === 2 ? "finished" : "playing");
    }
    expect(s.end.reason).toBe("lives");
    expect(s.end.trigger).toBe("miss");
  });
  test("a missing opportunity is replaced within 900ms without relabeling live cards", () => {
    const s = playing("http", 123);
    let longest = 0,
      gap = 0;
    for (let step = 0; step < 1200; step++) {
      for (const item of [...s.active].filter((q) => q.question.match)) collect(s, item.uid);
      const original = s.active.map((q) => ({ uid: q.uid, id: q.question.id }));
      tick(s, 100);
      for (const item of s.active) {
        const old = original.find((q) => q.uid === item.uid);
        if (old) expect(item.question.id).toBe(old.id);
      }
      gap = s.active.some((q) => q.question.match) ? 0 : gap + 100;
      longest = Math.max(longest, gap);
    }
    expect(longest).toBeLessThanOrEqual(900);
    expect(s.lives).toBe(3);
  });
  test("new runs use seed-specific rules, retry is reproducible, invalid deltas are ignored", () => {
    const a = playing("foundation", 100),
      retry = playing("foundation", 100),
      other = playing("foundation", 101);
    expect(a).toEqual(retry);
    expect(a.target).not.toEqual(other.target);
    for (const delta of [0, -1, NaN, Infinity]) tick(a, delta);
    expect(a).toEqual(retry);
  });
});

describe("user-triggered X sharing", () => {
  test("encodes title/mode/score and labels branch previews without inventing production", async () => {
    const { buildShare } = await import("../../landing/cloud-master/share.js");
    const s = createGame("http", 123);
    s.score = 1420;
    s.correct = 9;
    s.target.label = "HTTP & 日本語 #1";
    const preview = buildShare(s, { hostname: "localhost" });
    const intent = new URL(preview.intent);
    expect(intent.origin + intent.pathname).toBe("https://x.com/intent/tweet");
    expect(intent.searchParams.get("text")).toContain("1420 pt・9 正解");
    expect(intent.searchParams.get("text")).toContain("HTTP & 日本語 #1");
    expect(intent.searchParams.get("text")).toContain("プレビュー");
    expect(intent.searchParams.get("url")).toBe(
      "https://feat-cloud-master-game.tenkacloud-www.pages.dev/cloud-master/",
    );
    expect(buildShare(s, { hostname: "tenkacloud.com" }).url).toBe(
      "https://tenkacloud.com/cloud-master/",
    );
    expect(buildShare(s, { hostname: "abc123.tenkacloud-www.pages.dev" }).url).toBe(
      "https://abc123.tenkacloud-www.pages.dev/cloud-master/",
    );
    expect(buildShare(s, { hostname: "evil.invalid" }).url).not.toContain("evil");
  });
});
