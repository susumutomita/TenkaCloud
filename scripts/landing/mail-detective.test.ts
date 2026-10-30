import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, inspectionRow } from "../../landing/mail-detective/cases.js";
import { COPY } from "../../landing/mail-detective/copy.js";
import {
  advanceClock,
  createClock,
  inspectionOpen,
  progress,
  ROUND_WINDOW_MS,
  viewAfterAnswer,
} from "../../landing/mail-detective/deadline.js";
import { LEVELS } from "../../landing/mail-detective/levels.js";
import {
  asciiDomain,
  headerFacts,
  originalHeaders,
} from "../../landing/mail-detective/message-headers.js";
import {
  createRun,
  currentCase,
  end,
  expire,
  next,
  reveal,
  risks,
  tap,
  totals,
} from "../../landing/mail-detective/model.js";
import { REVIEW } from "../../landing/mail-detective/review.js";
import { cloudMasterFiles, cloudMasterVersion, stampCloudMasterFile } from "./stamp-asset-versions";

describe("email difference game", () => {
  test("starts playing directly with five ordered pairs and bounded progress", () => {
    const run = createRun(() => 0.5);
    expect(run.phase).toBe("playing");
    expect(run.rounds).toHaveLength(5);
    expect(new Set(run.rounds).size).toBe(5);
    expect(totals(run)).toEqual({
      found: 0,
      reviewed: 0,
      target: 1,
      mistakes: 0,
      score: 0,
      maxScore: 100,
      timeouts: 0,
    });
    expect(next(run)).toBe(run);
    expect(tap(run, "unknown")).toBe(run);
  });
  test("all pairs have three consequential changes and two justified normal variations", () => {
    expect(CASES).toHaveLength(5);
    const patterns = new Set();
    for (const item of CASES) {
      expect(item.rows).toHaveLength(5);
      expect(new Set(item.rows.map((row) => row.id)).size).toBe(5);
      const riskRows = item.rows.filter((row) => row.kind === "risk");
      expect(riskRows).toHaveLength(3);
      expect(item.rows.filter((row) => row.kind === "benign")).toHaveLength(2);
      patterns.add(
        riskRows
          .map((row) => row.id)
          .sort()
          .join(","),
      );
      for (const lang of ["ja", "en"]) {
        expect(item.context[lang].length).toBeGreaterThan(20);
        for (const row of item.rows) {
          for (const key of ["label", "before", "after", "reason", "detail"])
            expect(row[key][lang].length).toBeGreaterThan(1);
          expect(row.before[lang]).not.toBe(row.after[lang]);
        }
      }
    }
    expect(patterns.size).toBe(4);
  });
  test("normal variations cost five points without blocking the next attempt; repeated taps never double count", () => {
    let run = createRun(() => 0);
    const benign = currentCase(run).rows.find((row) => row.kind === "benign");
    const initial = JSON.stringify(run);
    const changed = tap(run, benign.id);
    expect(JSON.stringify(run)).toBe(initial);
    run = changed;
    expect(run.phase).toBe("playing");
    expect(totals(run).found).toBe(0);
    expect(run.feedback.kind).toBe("benign");
    expect(totals(run).mistakes).toBe(1);
    expect(totals(run).score).toBe(0);
    const id = risks(run)[0].id;
    for (let n = 0; n < 500; n++) run = tap(run, id);
    expect(totals(run).found).toBe(1);
    expect(totals(run).score).toBe(15);
    expect(run.checked[0]).toHaveLength(2);
  });
  test("completion requires all five rounds and no double next can skip a round", () => {
    let run = createRun(() => 0.1);
    for (let index = 0; index < 5; index++) {
      expect(run.index).toBe(index);
      expect(next(run)).toBe(run);
      for (const row of risks(run)) run = tap(run, row.id);
      expect(run.phase).toBe("round-complete");
      run = next(run);
    }
    expect(run.phase).toBe("results");
    expect(totals(run)).toEqual({
      found: 11,
      reviewed: 0,
      target: 11,
      mistakes: 0,
      score: 100,
      maxScore: 100,
      timeouts: 0,
    });
    expect(tap(run, risks(run)[0].id)).toBe(run);
  });
  test("showing answers is transparent and cannot turn reviewed spots into independent finds", () => {
    let run = createRun(() => 0.2, 3);
    run = tap(run, risks(run)[0].id);
    run = reveal(run);
    for (const row of risks(run)) run = tap(run, row.id);
    expect(totals(run)).toMatchObject({ found: 1, reviewed: 1, target: 2, mistakes: 0, score: 10 });
    expect(reveal(run)).toBe(run);
    run = reveal(next(run));
    run = next(run);
    expect(totals(run)).toMatchObject({ found: 1, reviewed: 4, target: 8, mistakes: 0, score: 10 });
  });
  test("finish early and fresh replay never pretend the learner completed unseen spots", () => {
    const run = end(createRun(() => 0.3));
    expect(run.phase).toBe("ended");
    expect(totals(run).found).toBe(0);
    expect(next(run)).toBe(run);
    expect(reveal(run)).toBe(run);
    expect(createRun(() => 0.4).phase).toBe("playing");
  });
  test("different random streams vary coherent text without skipping the taught sequence", () => {
    const combinations = new Set();
    for (let n = 0; n < 1000; n++) {
      let seed = ((n + 1) * 2654435761) >>> 0;
      const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const run = createRun(random);
      combinations.add(JSON.stringify(run.variants));
      expect(run.rounds).toEqual(LEVELS.map((entry) => entry.id));
    }
    expect(combinations.size).toBeGreaterThan(100);
    for (const value of [NaN, -1, 1, Infinity]) expect(() => createRun(() => value)).toThrow();
  });
  test("normal sender/path/request differences prevent memorising one universal dangerous row", () => {
    const normalIds = CASES.flatMap((item) =>
      item.rows.filter((row) => row.kind === "benign").map((row) => row.id),
    );
    for (const id of ["from", "link", "request"]) expect(normalIds).toContain(id);
    const values = CASES.flatMap((item) =>
      item.mailRows.flatMap((row) => [...Object.values(row.before), ...Object.values(row.after)]),
    );
    for (const value of values)
      for (const url of value.matchAll(/https:\/\/([^/"\s]+)\//g)) {
        expect(new URL(url[0]).hostname.endsWith(".example")).toBe(true);
      }
  });
  test("bilingual copy has matching keys and no course, registration or timer gate", () => {
    expect(Object.keys(COPY.ja).sort()).toEqual(Object.keys(COPY.en).sort());
    const html = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/index.html"),
      "utf8",
    );
    const game = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/game.js"),
      "utf8",
    );
    expect(html).not.toMatch(/<input|<form|googletagmanager|analytics\.js/);
    expect(html).toContain("connect-src 'none'");
    expect(game).not.toMatch(
      /fetch\(|XMLHttpRequest|sendBeacon|innerHTML|localStorage|setInterval|setTimeout/,
    );
    expect(game).toContain("let run = freshRun()");
    const css = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/game.css"),
      "utf8",
    );
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toContain("grid-template-columns:1fr");
  });
  test("the complete static module graph has one content hash and an LP link in each language", () => {
    const dir = join(import.meta.dir, "../../landing/mail-detective");
    const files = cloudMasterFiles(dir);
    const version = cloudMasterVersion(files);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain(`./game.js?v=${version}`);
    expect(html).toContain(`./game.css?v=${version}`);
    for (const [name, value] of Object.entries({ ...files, "index.html": html }))
      expect(stampCloudMasterFile(value, name, files, version)).toBe(value);
    for (const [file, lang] of [
      ["index.html", "ja"],
      ["index.en.html", "en"],
    ]) {
      const landing = readFileSync(
        join(import.meta.dir, "../../landing/", file),
        "utf8",
      ).replaceAll("&amp;", "&");
      expect(landing).toContain(`./portal-demo/?demo=1&goto=%2Fproblems%3Flang%3D${lang}`);
      expect(landing).not.toContain('id="cloud-foundations"');
    }
  });
});

describe("natural email presentation", () => {
  test("full messages retain all seven fields without changing the five authored decisions", () => {
    for (const item of CASES) {
      expect(item.mailRows.map((row) => row.id)).toEqual([
        "from",
        "subject",
        "date",
        "link",
        "request",
        "attachment",
        "reply",
      ]);
      expect(item.rows).toHaveLength(5);
      for (const row of item.rows)
        expect(item.mailRows.find((full) => full.id === row.id)).toBe(row);
    }
  });
  test("message inspection is collapsed initially and never contains real navigation or authentication fields", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/mail-view.js"),
      "utf8",
    );
    expect(source).toContain("headers.hidden = !ui.address[side]");
    expect(source).toContain("target.hidden = !ui.link[side]");
    expect(source).toContain('"learner@practice.example"');
    expect(source).not.toMatch(/href|window\.open|location\s*=|innerHTML|fetch\(/);
    expect(source).toContain("ui.lastTarget !== content.id");
    const css = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/mail.css"),
      "utf8",
    );
    expect(css).toContain(".email-card:not(.active-mobile){display:none}");
    expect(css).toContain("grid-template-columns:minmax(0,1fr) minmax(0,1fr)");
  });
  test("language changes keep disclosures while moving to the next round clears them", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/game.js"),
      "utf8",
    );
    const languageCode = source.slice(source.indexOf("function language("));
    expect(languageCode).not.toContain("mailUI = freshView()");
    expect(source).toContain("mailUI.address.received = risks(run).some");
    expect(source).toContain("mailUI.link.received = risks(run).some");
    expect(source).toContain("mailUI = freshView()");
  });
});

describe("simulated mail authentication and IDN", () => {
  test("simple attachments precede address/link work and the look-alike appears only at Lv5", () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const run = createRun(() => 0, level);
      expect(run.rounds).toEqual(LEVELS.slice(level - 1).map((entry) => entry.id));
      expect(currentCase(run).level).toBe(level);
      expect(currentCase(run).advanced).toBe(level === 5);
    }
  });
  test("SPF failure with aligned DKIM can pass DMARC, while unaligned passes cannot", () => {
    const reference = headerFacts(
      CASES.find((item) => item.id === "shared-file"),
      "reference",
    );
    expect(reference.spf).toBe("fail");
    expect(reference.dkim).toBe("pass");
    expect(reference.signingDomain).toBe(reference.fromDomain);
    expect(reference.dmarc).toBe("pass");
    const unaligned = headerFacts(
      CASES.find((item) => item.id === "account"),
      "received",
    );
    expect(unaligned.spf).toBe("pass");
    expect(unaligned.dkim).toBe("pass");
    expect(unaligned.signingDomain).not.toBe(unaligned.fromDomain);
    expect(unaligned.envelopeDomain).not.toBe(unaligned.fromDomain);
    expect(unaligned.dmarc).toBe("fail");
  });
  test("look-alike authentication passes for its own distinct domain without proving safety", () => {
    const item = CASES.find((entry) => entry.id === "lookalike");
    const from = item.mailRows.find((row) => row.id === "from").after.en;
    expect(from).toContain("\u0430");
    const facts = headerFacts(item, "received");
    expect(facts.fromDomain).toBe("xn--minmo-6ve.example");
    expect(facts.fromDomain).not.toBe("minamo.example");
    expect(facts.signingDomain).toBe(facts.fromDomain);
    expect(facts.dmarc).toBe("pass");
    expect(asciiDomain("minаmo.example")).toBe(facts.fromDomain);
    expect(asciiDomain("日本語.example")).toStartWith("xn--");
    for (const lang of ["ja", "en"]) {
      const headers = originalHeaders(item, "received", lang);
      for (const field of [
        "Authentication-Results: mx.practice.example;",
        "From:",
        "Reply-To:",
        "Return-Path:",
        "header.d=",
        "header.from=",
      ])
        expect(headers).toContain(field);
      expect(headers).not.toContain("DKIM-Signature:");
    }
  });
  test("authentication results are authored observations, with no DNS, mail or external lookups", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/message-headers.js"),
      "utf8",
    );
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|innerHTML|href\s*=|window\.open/);
    expect(source).toContain("panel.hidden = !ui.original[side]");
    expect(source).toContain("An identically named header");
    expect(source).toContain("Internationalized domains are not inherently dangerous");
  });
});

describe("automatic-processing deadline prototype", () => {
  test("active presented frames reach the boundary once, without a numeric countdown", () => {
    expect(ROUND_WINDOW_MS).toBe(30_000);
    let clock = createClock(0);
    for (let now = 100; now <= ROUND_WINDOW_MS; now += 100) clock = advanceClock(clock, now, true);
    expect(progress(clock)).toBe(1);
    expect(advanceClock(clock, ROUND_WINDOW_MS + 100, true).elapsed).toBe(ROUND_WINDOW_MS);
    expect(progress(createClock())).toBe(0);
  });
  test("inspection/background time, invalid timestamps and suspended frames never spend the window", () => {
    let clock = advanceClock(createClock(), 500, true);
    clock = advanceClock(clock, 90_000, false);
    clock = advanceClock(clock, 90_100, true);
    expect(clock.elapsed).toBe(600);
    clock = advanceClock(clock, 180_100, true);
    expect(clock.elapsed).toBe(600);
    expect(advanceClock(clock, NaN, true)).toBe(clock);
    expect(advanceClock(clock, Infinity, true)).toBe(clock);
    expect(advanceClock(clock, 0, true).elapsed).toBe(600);
  });
  test("timeout preserves independent finds, reveals misses, blocks late input and is idempotent", () => {
    let run = createRun(() => 0.4, 4);
    run = tap(run, risks(run)[0].id);
    run = expire(run);
    expect(run.phase).toBe("round-complete");
    expect(run.timedOut[run.index]).toBe(true);
    expect(totals(run)).toMatchObject({
      found: 1,
      reviewed: 2,
      target: 3,
      mistakes: 0,
      score: 6,
      timeouts: 1,
    });
    expect(expire(run)).toBe(run);
    expect(next(run).index).toBe(run.index + 1);
    expect(tap(run, risks(run)[1].id)).toBe(run);
    expect(reveal(run)).toBe(run);
    let completed = createRun(() => 0.5);
    for (const row of risks(completed)) completed = tap(completed, row.id);
    expect(expire(completed)).toBe(completed);
    expect(expire(end(createRun(() => 0.2))).phase).toBe("ended");
    expect(createClock(123).elapsed).toBe(0);
  });
});

test("input timestamps followed by an older RAF never rewind or double count the clock", () => {
  let clock = createClock(100000);
  clock = advanceClock(clock, 100020, true);
  expect(clock.elapsed).toBe(20);
  clock = advanceClock(clock, 100016, true);
  expect(clock.last).toBe(100020);
  expect(clock.elapsed).toBe(20);
  clock = advanceClock(clock, 100033, true);
  expect(clock.elapsed).toBe(33);
});

describe("TenkaCloud shell and end-of-play mail review", () => {
  test("review topics have bilingual where/check/action guidance and official references", () => {
    const ids = ["sender", "destination", "idn", "request", "authentication", "independent"];
    for (const lang of ["ja", "en"]) {
      expect(REVIEW[lang].items.map((item) => item.id)).toEqual(ids);
      expect(REVIEW[lang].labels).toHaveLength(3);
      for (const item of REVIEW[lang].items) {
        for (const key of ["title", "brief"]) expect(item[key].length).toBeGreaterThan(1);
        for (const key of ["where", "check", "action"])
          expect(item[key].length).toBeGreaterThan(20);
        expect(item.source.length).toBeGreaterThan(0);
      }
    }
    const content = JSON.stringify(REVIEW.en);
    for (const term of [
      "Reply-To",
      "From",
      "Return-Path",
      "header.d",
      "SPF",
      "DKIM",
      "DMARC",
      "Unicode",
      "Punycode",
      "U+0430",
      "minamo.example.notice.example",
      "grammar",
      "passwords",
      "payment",
      "bookmark",
    ])
      expect(content).toContain(term);
    expect(content).toContain("Internationalized domains are not inherently dangerous");
    expect(content).toContain("failure alone does not prove fraud");
    expect(content).toContain("Pass does not prove good intent");
  });
  test("review is optional after results; fictional mail cannot navigate to reference sites", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/review.js"),
      "utf8",
    );
    expect(source).toContain("details.open = openItems.has(item.id)");
    expect(source).toContain('link.rel = "noopener noreferrer"');
    expect(source).not.toMatch(/innerHTML|fetch\(|XMLHttpRequest|sendBeacon|localStorage/);
    const game = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/game.js"),
      "utf8",
    );
    const playCode = game.slice(
      game.indexOf("function playView("),
      game.indexOf("function resultsView("),
    );
    expect(playCode).not.toContain("createReview");
    expect(game).toContain("createReview(lang, guideOpen, currentLevel(run))");
    expect(game).toContain("guideOpen.clear()");
  });
  test("shell uses current LP tokens and font stack while keeping the separate email layout", () => {
    const brand = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/brand.css"),
      "utf8",
    );
    const lp = readFileSync(join(import.meta.dir, "../../landing/styles/main.css"), "utf8");
    for (const token of [
      "#07111f",
      "#0969da",
      "#008a55",
      "#d9dee8",
      "#f5f7fb",
      '"Inter"',
      '"Noto Sans JP"',
    ]) {
      expect(brand).toContain(token);
      expect(lp).toContain(token);
    }
    expect(brand).toContain("border-radius:999px");
    expect(brand).not.toMatch(/@import|https?:|\.mail-body|\.message-header/);
  });
});

describe("all answer controls have neutral affordances", () => {
  test.each(LEVELS.map((definition) => [definition.level, definition]))(
    "flagging neutral content in %s costs five points per distinct answer",
    (level) => {
      let run = createRun(() => 0, level);
      const item = currentCase(run);
      const neutralIds = [
        ...item.mailRows.filter((entry) => entry.kind !== "risk").map((entry) => entry.id),
        "greeting",
        "opening",
        "signature",
        "display-name",
        "to",
      ];
      for (const id of neutralIds) {
        const row = inspectionRow(item, id);
        expect(row).toBeDefined();
        expect(row.kind).not.toBe("risk");
        run = tap(run, id);
        expect(run.feedback.id).toBe(id);
        expect(run.feedback.fresh).toBe(false);
        expect(run.phase).toBe("playing");
        const mistakes = run.checked[0].length;
        expect(totals(run)).toEqual({
          found: 0,
          reviewed: 0,
          target: risks(run).length,
          mistakes,
          score: 0,
          maxScore: (6 - level) * 20,
          timeouts: 0,
        });
        const repeat = tap(run, id);
        expect(totals(repeat)).toEqual(totals(run));
        expect(repeat.feedback.delta).toBe(0);
        expect(run.found[0]).toHaveLength(0);
      }
      expect(inspectionRow(item, "unknown")).toBeUndefined();
      for (const row of risks(run)) run = tap(run, row.id);
      expect(run.phase).toBe("round-complete");
      expect(totals(run).found).toBe(risks(run).length);
    },
  );
  test("generic answer hover does not add a dotted underline; real link and focus remain visible", () => {
    const css = readFileSync(
      join(import.meta.dir, "../../landing/mail-detective/mail.css"),
      "utf8",
    );
    const hover = css.match(/\.mail-spot:hover\{([^}]*)\}/)?.[1];
    expect(hover).toContain("text-decoration:none");
    expect(hover).not.toContain("text-decoration:underline");
    expect(hover).not.toContain("dotted");
    expect(css.match(/\.mail-link\{([^}]*)\}/)?.[1]).toContain("text-decoration:underline");
    expect(css).toContain("button:focus-visible{outline:3px");
  });
});

describe("answer feedback and inspection clock boundaries", () => {
  const view = () => ({
    active: "received",
    lastTarget: null,
    idnOpen: {},
    address: { reference: false, received: false },
    link: { reference: false, received: false },
    original: { reference: false, received: false },
  });
  test("a selected correct or incorrect answer never creates an inspection pause", () => {
    for (const id of ["spot-attachment-file", "spot-greeting-body"]) {
      const before = {
        ...view(),
        address: { reference: true, received: true },
        link: { reference: true, received: true },
      };
      expect(inspectionOpen(before, true)).toBe(true);
      const answered = viewAfterAnswer(before, id);
      expect(answered.lastTarget).toBe(id);
      expect(inspectionOpen(answered, true)).toBe(false);
      expect(before.address.received).toBe(true);
      let clock = advanceClock(createClock(), 500, true);
      clock = advanceClock(clock, 900, !inspectionOpen(before, true));
      expect(clock.elapsed).toBe(500);
      clock = advanceClock(clock, 1000, !inspectionOpen(answered, true));
      expect(clock.elapsed).toBe(600);
    }
  });
  test("only explicit details/reference viewing pauses and closing them resumes", () => {
    const base = view();
    expect(inspectionOpen(base, true)).toBe(false);
    expect(inspectionOpen({ ...base, active: "reference" }, true)).toBe(true);
    expect(inspectionOpen({ ...base, active: "reference" }, false)).toBe(false);
    for (const key of ["address", "link", "original"])
      expect(inspectionOpen({ ...base, [key]: { reference: false, received: true } }, false)).toBe(
        true,
      );
    expect(inspectionOpen(base, false, true)).toBe(true);
    expect(inspectionOpen(base, false, false)).toBe(false);
  });
  test("partial finds survive timeout while shown answers and repeated expiry earn nothing", () => {
    let run = createRun(() => 0);
    run = tap(run, risks(run)[0].id);
    expect(totals(run).score).toBe(20);
    expect(expire(run)).toBe(run);
    run = next(run);
    run = tap(run, risks(run)[0].id);
    expect(totals(run).score).toBe(30);
    run = expire(run);
    expect(totals(run)).toMatchObject({
      score: 30,
      maxScore: 100,
      found: 2,
      reviewed: 1,
      timeouts: 1,
    });
    expect(expire(run)).toBe(run);
    expect(tap(run, risks(run)[1].id)).toBe(run);
    while (run.phase !== "results") {
      run = next(run);
      if (run.phase === "playing") run = expire(run);
    }
    expect(totals(run)).toMatchObject({ score: 30, maxScore: 100, found: 2, timeouts: 4 });
  });
  test("five unanswered rounds finish at zero even though every missed spot is shown", () => {
    let run = createRun(() => 0);
    while (run.phase !== "results") {
      run = expire(run);
      expect(totals(run).found).toBe(0);
      expect(totals(run).score).toBe(0);
      for (const row of risks(run)) expect(tap(run, row.id)).toBe(run);
      run = next(run);
    }
    expect(totals(run)).toMatchObject({
      score: 0,
      maxScore: 100,
      found: 0,
      reviewed: 11,
      timeouts: 5,
    });
  });
});
