import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { COPY } from "../../landing/mail-detective/copy.js";
import { element } from "../../landing/mail-detective/dom.js";
import { LEVELS } from "../../landing/mail-detective/levels.js";
import {
  createRun,
  end,
  expire,
  next,
  risks,
  tap,
  totals,
} from "../../landing/mail-detective/model.js";
import { createResultsView } from "../../landing/mail-detective/result-view.js";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
});
afterEach(() => {
  dom.window.close();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function mount(run, lang = "ja") {
  const actions: string[] = [];
  const before = JSON.stringify(run);
  document.body.append(
    createResultsView({
      t: COPY[lang],
      run,
      lang,
      guideOpen: new Set(),
      onReplay: () => actions.push("replay"),
      onRestart: () => actions.push("restart"),
    }),
  );
  expect(JSON.stringify(run)).toBe(before);
  return actions;
}

describe("mail result presentation preserves the run contract", () => {
  test.each(["ja", "en"])("unanswered rounds remain zero in the result and share in %s", (lang) => {
    let run = createRun(() => 0);
    while (run.phase !== "results") run = next(expire(run));
    const actions = mount(run, lang);
    expect(document.querySelector(".result-score")?.textContent).toContain("0 / 100");
    expect(document.querySelector(".result-count")?.textContent).toContain("0/11");
    const share = document.querySelector<HTMLAnchorElement>("#share-result");
    expect(share).not.toBeNull();
    expect(new URL(share?.href ?? "").searchParams.get("text")).toContain("0/100");
    document.querySelector<HTMLButtonElement>("#again")?.click();
    expect(actions).toEqual(["replay"]);
    expect(document.querySelector("#restart-levels")).toBeNull();
    expect(document.querySelector("#continue-level")).toBeNull();
  });

  test.each([1, 2, 3, 4, 5])("every valid Lv%i start finishes at the last lesson", (level) => {
    let run = createRun(() => 0, level);
    while (run.phase !== "results") {
      for (const risk of risks(run)) run = tap(run, risk.id);
      run = next(run);
    }
    mount(run);
    expect(run.startLevel + run.rounds.length).toBe(LEVELS.length + 1);
    expect(document.querySelector("#continue-level")).toBeNull();
    expect(totals(run).score).toBe(20 * (LEVELS.length - level + 1));
    expect(Boolean(document.querySelector("#restart-levels"))).toBe(level > 1);
  });

  test("replay and restart stay distinct for an early-ended advanced start", () => {
    const actions = mount(end(createRun(() => 0, 3)), "en");
    document.querySelector<HTMLButtonElement>("#again")?.click();
    document.querySelector<HTMLButtonElement>("#restart-levels")?.click();
    expect(actions).toEqual(["replay", "restart"]);
    expect(document.querySelector("#round-title")?.getAttribute("tabindex")).toBe("-1");
  });

  test("the legacy terminal timeout view retains missed explanations and its retry action", () => {
    const source = createRun(() => 0, 3);
    const run = { ...source, phase: "timed-out" };
    const actions = mount(run);
    expect(document.querySelector("#round-title")?.textContent).toBe(COPY.ja.timedOut);
    expect(document.querySelectorAll(".missed-spots p")).toHaveLength(risks(source).length);
    document.querySelector<HTMLButtonElement>("#again")?.click();
    expect(actions).toEqual(["replay"]);
  });

  test("shared view elements keep authored strings as text, never HTML", () => {
    const text = '<img src="https://outside.example/tracker">';
    const label = element("p", text, "label");
    expect(label.textContent).toBe(text);
    expect(label.querySelector("img")).toBeNull();
    expect(label.className).toBe("label");
  });
});
