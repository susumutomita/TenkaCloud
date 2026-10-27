import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { ALL_RULES_AT, LESSONS } from "../../landing/cloud-master/curriculum.js";
import { collect, createGame, start, tickFrame } from "../../landing/cloud-master/engine.js";
import { explanationCard } from "../../landing/cloud-master/explanation.js";
import { chooseLocale, tr } from "../../landing/cloud-master/i18n.js";
import { EN_SCENARIOS } from "../../landing/cloud-master/locales/en-scenarios.js";
import { EN_UI } from "../../landing/cloud-master/locales/en-ui.js";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";
import { buildShare } from "../../landing/cloud-master/share.js";
import { formatSurvival } from "../../landing/cloud-master/time.js";

const catalog = await loadCatalog();
// Match the browser graph's module identity: explanation.js imports this versioned module.
const version = readFileSync(
  new URL("../../landing/cloud-master/index.html", import.meta.url),
  "utf8",
).match(/game\.js\?v=([a-f0-9]{10})/)?.[1];
const { englishScenarioIds, loadQuestionLocale, questionView, validateEnglishCatalog } =
  await import(`../../landing/cloud-master/question-locales.js?v=${version}`);
await loadQuestionLocale("en");
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/u;
function generated(s, danger, seed = 37) {
  const stream = createQuestionStream(catalog, seed);
  Object.assign(stream, {
    elapsed: ALL_RULES_AT,
    scenarioTier: LESSONS.length,
    scenarioBag: [s],
    outcomes: [danger],
  });
  return nextQuestion(stream);
}
test("all259 English scenarios and506 outcomes fully localize evidence, conditions, details and reasons without mutating answers", () => {
  const all = availableScenarios(catalog);
  expect(englishScenarioIds().sort()).toEqual(all.map((s) => s.id).sort());
  for (const s of all)
    for (const danger of [false, true]) {
      const q = generated(s, danger),
        before = JSON.stringify(q),
        view = questionView(q, "en"),
        explanation = explanationCard(q, "en");
      for (const key of [
        "payload",
        "policy",
        "observed",
        "wire",
        "headline",
        "reason",
        "successReason",
        "fullReason",
        "actual",
        "expected",
        "field",
        "operation",
        "meaning",
        "service",
      ]) {
        expect(view[key]).toBeDefined();
        expect(view[key]).not.toMatch(japanese);
      }
      expect(explanation.headline).toBe(EN_SCENARIOS[s.id].meaningTitle);
      expect(view.source).toBe(q.source);
      expect(q.danger).toBe(danger);
      expect(JSON.stringify(q)).toBe(before);
      expect(questionView(q, "ja").payload).toBe(q.payload);
    }
});
test("randomized indicator values and numeric evidence retain the actual sampled criterion in English", () => {
  for (const s of availableScenarios(catalog).filter((s) => s.family))
    for (const seed of [1, 12, 37])
      for (const danger of [false, true]) {
        const q = generated(s, danger, seed),
          view = questionView(q, "en");
        if (
          typeof q.context.actual === "number" ||
          /^\d+\.\d+\.\d+\.\d+$/.test(String(q.context.actual))
        )
          expect(view.payload).toContain(String(q.context.actual));
        if (q.context.operator === "gt")
          expect(view.fullReason).toContain(String(q.context.threshold));
      }
});
function idealDecisions(s) {
  for (const item of [...s.active])
    if (item.question.danger && s.elapsed - item.born >= 100) collect(s, item.uid);
}
function renderViews(s, locale) {
  for (const item of s.active) {
    questionView(item.question, locale);
    explanationCard(item.question, locale);
  }
}
test("presentation switches leave clock, IDs, RNG, scoring, lifetimes and history identical", () => {
  const a = createGame(catalog, 28),
    b = createGame(catalog, 28);
  a.maxCards = 4;
  b.maxCards = 4;
  start(a);
  start(b);
  for (let i = 0; i < 2200; i++) {
    tickFrame(a, 100);
    tickFrame(b, 100);
    renderViews(b, i % 2 ? "en" : "ja");
    idealDecisions(a);
    idealDecisions(b);
    expect(b.rng).toBe(a.rng);
    expect(b.elapsed).toBe(a.elapsed);
    expect(b.score).toBe(a.score);
    expect(b.lives).toBe(a.lives);
    expect(b.active.map((x) => [x.uid, x.born, x.deadline])).toEqual(
      a.active.map((x) => [x.uid, x.born, x.deadline]),
    );
  }
  expect(b.history).toEqual(a.history);
});
test("English UI messages preserve placeholders and every literal message has an English translation", () => {
  for (const [key, value] of Object.entries(EN_UI)) {
    expect(value).not.toMatch(japanese);
    expect([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()).toEqual(
      [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
    );
  }
  for (const path of ["game.js", "feedback.js", "share.js"]) {
    const source = readFileSync(
      new URL(`../../landing/cloud-master/${path}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/tr\(\s*("(?:[^"\\]|\\.)*")/g)) {
      const key = JSON.parse(match[1]);
      expect(EN_UI[key]).toBeDefined();
    }
  }
});
test("feedback announcements use English punctuation while preserving Japanese text and actual values", () => {
  expect(
    tr(
      "{summary}。{detail}",
      {
        summary: "Request a public object listing",
        detail: "ACL: public-read",
      },
      "en",
    ),
  ).toBe("Request a public object listing. ACL: public-read");
  expect(
    tr(
      "{summary}。{detail}",
      {
        summary: "ファイル一覧を誰に見せるかの設定",
        detail: "一覧を公開しない指定です。",
      },
      "ja",
    ),
  ).toBe("ファイル一覧を誰に見せるかの設定。一覧を公開しない指定です。");
});
test("language preference prioritizes manual selection and legacy Japanese users; fresh English browsers start English", () => {
  expect(chooseLocale({ saved: "ja", languages: ["en-US"] })).toBe("ja");
  expect(chooseLocale({ saved: "en", languages: ["ja-JP"] })).toBe("en");
  expect(chooseLocale({ legacyRecord: true, languages: ["en-US"] })).toBe("ja");
  expect(chooseLocale({ languages: ["en-GB"] })).toBe("en");
  expect(chooseLocale({ languages: ["ja-JP"] })).toBe("ja");
  expect(chooseLocale({ saved: "ja", requested: "en" })).toBe("en");
  expect(() => tr("MISSING", {}, "en")).toThrow();
});
test("English timer and user-triggered share keep completed tenths and an English game link", () => {
  expect(formatSurvival(1299, "en")).toBe("1.2s");
  expect(formatSurvival(1300, "en")).toBe("1.3s");
  expect(formatSurvival(1299, "ja")).toBe("1.2秒");
  const state = createGame(catalog, 28);
  state.elapsed = 123456;
  const share = buildShare(state, { hostname: "localhost" }, "en");
  expect(share.text).not.toMatch(japanese);
  expect(share.text).toContain("123.4s");
  expect(new URL(share.url).searchParams.get("lang")).toBe("en");
  expect(new URL(share.intent).searchParams.get("lang")).toBe("en");
});

test("incomplete English catalogs fail explicitly", () => {
  expect(() => validateEnglishCatalog(EN_SCENARIOS)).not.toThrow();
  const missing = Object.fromEntries(
    Object.entries(EN_SCENARIOS).filter(([id]) => id !== "EC2PasswordDataRetrieved"),
  );
  expect(() => validateEnglishCatalog(missing)).toThrow();
});
