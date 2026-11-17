import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const root = join(import.meta.dir, "../..");
const read = (name: string) => readFileSync(join(root, "landing", name), "utf8");

describe("platform message and retained detail", () => {
  for (const file of ["index.html", "index.en.html"]) {
    it(`${file} distinguishes the product, available actions and one future example`, () => {
      const { document } = new JSDOM(read(file)).window;
      const hero = document.querySelector(".hero");
      expect(hero?.textContent).toMatch(/OSS の演習・競技基盤|open-source platform/);
      expect(hero?.textContent).not.toMatch(/3分|Three minutes|BROKEN ACCESS CONTROL/);
      const main = document.querySelector("main");
      const order = [...(main?.children ?? [])].map((node) => node.id);
      expect(order.indexOf("platform")).toBeLessThan(order.indexOf("practice-question"));
      expect(order.indexOf("practice-question")).toBeLessThan(order.indexOf("why"));
      const question = document.querySelector("#practice-question");
      expect(question?.querySelector("h2")?.textContent).toMatch(
        /ニュースで聞く情報漏えい|Data breaches make the news/,
      );
      expect(question?.textContent).toMatch(/一例|one example/);
      expect(question?.textContent).toMatch(/未公開|not published yet/);
      expect(question?.querySelector("a,button")).toBeNull();
      expect(order.indexOf("try")).toBeLessThan(order.indexOf("examples"));
      expect(document.querySelectorAll(".platform-start-option")).toHaveLength(3);
      expect(document.querySelector("#try")?.textContent).toMatch(/クラウド|Environment/);
      const example = document.querySelector<HTMLDetailsElement>(".platform-case");
      expect(example?.open).toBe(false);
      expect(example?.textContent).toMatch(/開発中|in development|in-development/);
      expect(example?.querySelector("[data-i18n='hero.tagline']")?.textContent).toMatch(
        /3分|three minutes/i,
      );
    });

    it(`${file} preserves operational, authoring and commercial information in native details`, () => {
      const { document } = new JSDOM(read(file)).window;
      for (const id of [
        "modes",
        "use-cases",
        "extend",
        "book",
        "offerings",
        "pricing",
        "contact",
      ]) {
        expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
        expect(document.getElementById(id)?.closest("details")).not.toBeNull();
      }
      expect(document.querySelectorAll("summary :is(h1,h2,h3,h4,h5,h6)")).toHaveLength(0);
      expect(document.querySelectorAll("details[name]")).toHaveLength(0);
      expect(document.querySelector("#contact a")?.getAttribute("href")).toBe(
        "https://forms.gle/djVprYmq3hFgJA7P9",
      );
      expect(document.querySelectorAll("#use-cases .col")).toHaveLength(6);
      expect(document.querySelectorAll(".book-edition")).toHaveLength(2);
    });
  }

  it("prints preserved details and restores the reader's open choices across repeated prints", () => {
    const dom = new JSDOM(read("index.html"), { runScripts: "outside-only" });
    const { window } = dom;
    const items = [...window.document.querySelectorAll<HTMLDetailsElement>("details")];
    const initiallyOpen = items[1];
    if (!initiallyOpen) throw new Error("Expected operational detail");
    initiallyOpen.open = true;
    const initial = items.map((item) => item.open);
    window.eval(read("platform-page.js"));
    for (let cycle = 0; cycle < 2; cycle++) {
      window.dispatchEvent(new window.Event("beforeprint"));
      window.dispatchEvent(new window.Event("beforeprint"));
      expect(items.every((item) => item.open)).toBe(true);
      window.dispatchEvent(new window.Event("afterprint"));
      expect(items.map((item) => item.open)).toEqual(initial);
    }
    window.close();
  });
});
