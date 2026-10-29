import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  collect,
  createGame,
  enableRenderTracking,
  finish,
  frameStep,
  pause,
  resume,
  showLesson,
  start,
  tickFrame,
  tickInput,
} from "../../landing/cloud-master/engine.js";
import { reviewEntries } from "../../landing/cloud-master/feedback.js";
import { flowPositions } from "../../landing/cloud-master/motion.js";
import { difficulty, pressureFor } from "../../landing/cloud-master/recognition.js";
import { observeFrame } from "../../landing/cloud-master/render-budget.js";
import { buildShare } from "../../landing/cloud-master/share.js";

const catalog = await loadCatalog();
function tracked(level: number, fps = 60, capacity = 6) {
  const s = createGame(catalog, 37);
  enableRenderTracking(s, { width: 1440, height: 900, dpr: 1, userAgent: "deterministic QA" });
  for (let i = 0; i < 60; i++) observeFrame(s.renderBudget, 1000 / fps);
  Object.assign(s, {
    level,
    taughtLevel: level,
    correct: (level - 1) * 5,
    pressureIndex: pressureFor(level),
    maxCards: capacity,
    outcomes: Array(1000).fill(false),
  });
  start(s);
  return s;
}
function render(s) {
  for (const item of s.active)
    item.renderedEligible = !item.presentationPending && s.elapsed - item.born >= item.inputGuardMs;
}
test.each([30, 60, 120])(
  "%ifps has an explicit device-specific measurement end before unpresentable flight",
  (fps) => {
    const frame = 1000 / fps,
      threshold = Math.floor(105 * (600 / (3 * frame)) ** 2),
      s = tracked(threshold + 1, fps);
    frameStep(s, frame);
    expect(s.phase).toBe("finished");
    expect(s.end.reason).toBe("measurement-limit");
    expect(s.mistakes).toBe(0);
    expect(s.lives).toBe(3);
    expect(s.passed).toBe(0);
    expect(s.active).toEqual([]);
    expect(s.end.measurement.limitingFrameMs).toBeCloseTo(frame, 8);
    expect(s.end.measurement.requiredFlightMs).toBeCloseTo(frame * 3, 8);
    const safe = tracked(threshold - 1, fps);
    frameStep(safe, frame);
    expect(safe.phase).toBe("playing");
  },
);
test.each([105, 200, 500, 1000, 10000, Number.MAX_SAFE_INTEGER])(
  "level %i renders or ends distinctly,including input-before-paint",
  (level) => {
    const s = tracked(level),
      card = s.active[0];
    expect(card.presentationPending).toBe(true);
    expect(collect(s, card.uid)).toBe(false);
    tickInput(s, 0.01);
    expect(s.passed).toBe(0);
    expect(s.score).toBe(0);
    for (let i = 0; i < 120 && s.phase === "playing"; i++) {
      render(s);
      frameStep(s, 1000 / 60);
    }
    if (difficulty(level).fallMs < 50) {
      expect(s.phase).toBe("finished");
      expect(s.end.reason).toBe("measurement-limit");
      expect(s.mistakes).toBe(0);
    } else {
      expect(s.phase).toBe("playing");
      expect(s.passed).toBeGreaterThan(0);
      expect(s.score).toBe(s.passed * 10);
    }
  },
);
test("no score or loss until the renderer has presented an eligible card,not merely admitted one", () => {
  const s = tracked(1000);
  for (let i = 0; i < 100; i++) frameStep(s, 1000 / 60);
  expect(s.passed).toBe(0);
  expect(s.mistakes).toBe(0);
  expect(s.active.length).toBeLessThanOrEqual(6);
  render(s);
  frameStep(s, 1000 / 60);
  expect(s.mistakes).toBe(0);
});
test("one anomalous visible frame and background suspension never manufacture a limit", () => {
  const s = tracked(1000);
  render(s);
  frameStep(s, 1000 / 60);
  const elapsed = s.elapsed;
  frameStep(s, 10000);
  expect(s.phase).toBe("playing");
  expect(s.elapsed).toBe(elapsed);
  expect(s.mistakes).toBe(0);
  expect(s.renderBudget.ignoredFrames).toBe(1);
  frameStep(s, 10000, false);
  expect(s.phase).toBe("paused");
  expect(s.elapsed).toBe(elapsed);
  resume(s);
  render(s);
  frameStep(s, 1000 / 60);
  expect(s.phase).toBe("playing");
  pause(s);
  frameStep(s, 10000);
  expect(s.end).toBe(null);
});
test("eight sustained foreground slow frames are qualified evidence,not a single hitch", () => {
  const s = tracked(1000);
  for (let i = 0; i < 7; i++) frameStep(s, 500);
  expect(s.phase).toBe("playing");
  expect(s.elapsed).toBe(0);
  frameStep(s, 500);
  expect(s.phase).toBe("finished");
  expect(s.end.measurement.terminalReason).toBe("sustained-slow-frames");
  expect(s.end.measurement.slowFrameEvidence).toHaveLength(8);
  expect(s.end.measurement.ignoredMs).toBe(4000);
  expect(s.lives).toBe(3);
  expect(s.mistakes).toBe(0);
  const early = tracked(1);
  for (let i = 0; i < 8; i++) frameStep(early, 500);
  expect(early.phase).toBe("playing");
});
test("limit results are idempotent,share their context without claiming failure,and restart cleanly", () => {
  const s = tracked(Number.MAX_SAFE_INTEGER);
  frameStep(s, 1000 / 60);
  const end = s.end,
    score = s.score,
    elapsed = s.elapsed;
  finish(s);
  resume(s);
  tickInput(s, 1e6);
  frameStep(s, 1000);
  collect(s, 0);
  expect(s.end).toBe(end);
  expect(s.score).toBe(score);
  expect(s.elapsed).toBe(elapsed);
  const share = buildShare(s, { hostname: "tenkacloud.com" }, "en");
  expect(share.text).toContain("Measurement limit reached");
  expect(share.text).toContain("device-specific");
  expect(share.text).toContain("1440×900");
  const fresh = createGame(catalog, 37);
  expect(fresh.end).toBe(null);
  expect(fresh.level).toBe(1);
  expect(fresh.renderBudget.samples).toEqual([]);
  expect(fresh.score).toBe(0);
});
test.each([2, 3, 6])(
  "coalesced slow-to-fast switch drains old cards before new fast ones,capacity%i",
  (capacity) => {
    const s = createGame(catalog, 37);
    Object.assign(s, {
      level: 226,
      taughtLevel: 226,
      pressureIndex: pressureFor(226),
      correct: 1236 * 5 + 3,
      maxCards: capacity,
      outcomes: Array(1000).fill(false),
    });
    start(s);
    tickFrame(s, 500);
    showLesson(s);
    let primed = false;
    const template = { ...s.active[0] };
    let drainSeen = false,
      oldIds = new Set<number>(),
      beforeSerial = 0,
      oldDeadlines = new Map<number, number>();
    for (let i = 0; i < 400; i++) {
      if (!primed) primed = primeBlockingCard(s, template);
      if (s.pressureDrain && !drainSeen) {
        drainSeen = true;
        oldIds = new Set(s.active.map((x) => x.uid));
        beforeSerial = s.serial;
        oldDeadlines = new Map(s.active.map((x) => [x.uid, x.deadline]));
      }
      for (const x of s.active)
        if (oldDeadlines.has(x.uid)) expect(x.deadline).toBe(oldDeadlines.get(x.uid));
      if (drainSeen && s.active.some((x) => x.uid >= beforeSerial)) {
        expect(s.active.every((x) => !oldIds.has(x.uid))).toBe(true);
        const card = s.active.find((x) => x.uid >= beforeSerial);
        const y = flowPositions(
          [{ ...card, height: 172 }],
          new Map(),
          card.deadline - 1e-6,
          555,
          1,
        )[0].y;
        expect(555 - 172 - y).toBeLessThan(0.01);
        return;
      }
      tickFrame(s, 16.667);
    }
    throw Error("pressure drain never completed");
  },
);

function primeBlockingCard(s, template) {
  if (!s.lessonNotice || s.lessonNotice.readRemaining + s.lessonNotice.graceRemaining >= 100)
    return false;
  const item = s.active[0] ?? { ...template, uid: s.serial++, slot: 0 };
  item.born = s.elapsed;
  item.deadline = s.elapsed + item.flightMs;
  if (!s.active.length) s.active.push(item);
  return true;
}
test("input-consumed clock delta never masquerades as a faster RAF sample", () => {
  const s = tracked(1000);
  for (let i = 0; i < 120; i++) {
    tickInput(s, 15.667);
    render(s);
    frameStep(s, 1, true, 16.667);
  }
  expect(s.renderBudget.samples.every((ms) => ms > 16)).toBe(true);
  const extreme = tracked(1000000);
  tickInput(extreme, 15.667);
  frameStep(extreme, 1, true, 16.667);
  expect(extreme.end.reason).toBe("measurement-limit");
  expect(extreme.end.measurement.frameP90Ms).toBeGreaterThan(16);
});

test("long-run review keeps result DOM bounded while retaining mistakes and final decisions", () => {
  const rows = Array.from({ length: 50000 }, (_, uid) => ({
    uid,
    at: uid,
    correct: ![0, 25000, 49999].includes(uid),
  }));
  const selected = reviewEntries(rows);
  expect(selected.length).toBeLessThanOrEqual(53);
  expect(selected.some((x) => x.uid === 0)).toBe(true);
  expect(selected.some((x) => x.uid === 25000)).toBe(true);
  expect(selected[0].uid).toBe(49999);
  expect(rows.length).toBe(50000);
});

test("sustained-delay sharing labels the limiting median without falsely calling it p90", () => {
  const s = tracked(1000);
  for (const ms of [200, 300, 400, 500, 600, 700, 800, 900]) frameStep(s, ms);
  expect(s.end.measurement.limitingFrameMs).toBe(500);
  expect(s.end.measurement.frameP90Ms).toBe(900);
  const text = buildShare(s, { hostname: "tenkacloud.com" }, "en").text;
  expect(text).toContain("limiting frame interval 500.0ms");
  expect(text).not.toContain("p90 500");
});

test("paused/terminal input and invalid clocks cannot mutate render evidence", () => {
  const s = tracked(1000);
  pause(s);
  const paused = JSON.stringify(s.renderBudget);
  tickInput(s, 10000);
  frameStep(s, 10000, false);
  expect(JSON.stringify(s.renderBudget)).toBe(paused);
  resume(s);
  const active = JSON.stringify(s.renderBudget);
  for (const delta of [NaN, Infinity, -1]) {
    tickInput(s, delta);
    frameStep(s, delta);
    frameStep(s, 1, true, delta);
  }
  expect(JSON.stringify(s.renderBudget)).toBe(active);
  const end = tracked(Number.MAX_SAFE_INTEGER);
  frameStep(end, 16.667);
  const frozen = JSON.stringify(end.renderBudget);
  tickInput(end, 10000);
  frameStep(end, 10000);
  frameStep(end, 10000, false);
  expect(JSON.stringify(end.renderBudget)).toBe(frozen);
});
