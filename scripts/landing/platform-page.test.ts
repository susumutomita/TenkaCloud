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
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {
      /* Print test does not schedule scene frames. */
    };
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

describe("full-size product scene", () => {
  function setup(mode: "dom" | "canvas" | "failure", reduced = false) {
    const dom = new JSDOM(read("index.html"), {
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const { window } = dom;
    let frame: FrameRequestCallback | undefined;
    let draws = 0;
    let disconnected = 0;
    let resized: (() => void) | undefined;
    let visibility: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: reduced,
        addEventListener() {
          /* Motion preference is fixed in this fixture. */
        },
      }),
    });
    window.requestAnimationFrame = (callback) => {
      frame = callback;
      return 1;
    };
    window.cancelAnimationFrame = () => {
      frame = undefined;
    };
    Object.defineProperty(window, "IntersectionObserver", {
      value: class {
        constructor(callback: typeof visibility) {
          visibility = callback;
        }
        observe() {
          /* Geometry is controlled by this fixture. */
        }
        disconnect() {
          disconnected++;
        }
      },
    });
    Object.defineProperty(window, "ResizeObserver", {
      value: class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {
          /* Resize is triggered explicitly. */
        }
        disconnect() {
          /* Cleanup is covered by intersection observation. */
        }
      },
    });
    const context = {
      setTransform() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      clearRect() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      save() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      beginPath() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      rect() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      clip() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      translate() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      restore() {
        /* Paint bookkeeping is not relevant to scene state assertions. */
      },
      drawElementImage() {
        draws++;
        if (mode === "failure") throw new Error("native paint failed");
      },
    };
    if (mode !== "dom") {
      Object.defineProperty(window.HTMLCanvasElement.prototype, "content", { value: "drawable" });
      Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
        value: () => context,
      });
    }
    window.eval(read("platform-page.js"));
    const scene = window.document.querySelector<HTMLElement>(".platform-scene");
    const hero = window.document.querySelector<HTMLElement>(".hero");
    const buttons = [...window.document.querySelectorAll<HTMLButtonElement>("[data-scene-select]")];
    const panels = [...window.document.querySelectorAll<HTMLElement>("[data-scene-panel]")];
    return {
      window,
      scene,
      hero,
      buttons,
      panels,
      draw: (elapsed = 200) => {
        const next = frame;
        frame = undefined;
        next?.(window.performance.now() + elapsed);
      },
      resize: () => resized?.(),
      draws: () => draws,
      offscreen: () => visibility?.([{ isIntersecting: false }]),
      frame: () => frame,
      disconnected: () => disconnected,
    };
  }

  it("switches meaningful product views and pressed state without a canvas API", () => {
    const test = setup("dom");
    test.buttons[1]?.click();
    expect(test.scene?.dataset.renderer).toBe("dom");
    expect(test.hero?.dataset.heroScene).toBe("1");
    expect(test.panels.map((panel) => panel.hidden)).toEqual([true, false]);
    expect(test.buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    test.buttons[0]?.click();
    expect(test.panels.map((panel) => panel.hidden)).toEqual([false, true]);
  });

  it("draws native HTML only during a bounded scene change, then stops offscreen", () => {
    const test = setup("canvas");
    test.buttons[1]?.click();
    test.draw();
    expect(test.draws()).toBe(12);
    expect(test.scene?.dataset.renderer).toBe("canvas");
    test.resize();
    expect(test.frame()).toBeDefined();
    test.draw(900);
    expect(test.frame()).toBeUndefined();
    test.buttons[0]?.click();
    expect(test.frame()).toBeDefined();
    const canvas = test.window.document.querySelector<HTMLCanvasElement>(".platform-scene-canvas");
    expect(canvas?.width).toBeLessThanOrEqual(1100);
    expect(canvas?.height).toBeLessThanOrEqual(750);
    test.offscreen();
    expect(test.frame()).toBeUndefined();
    expect(canvas?.style.opacity).toBe("0");
    test.window.dispatchEvent(new test.window.PageTransitionEvent("pagehide"));
    expect(test.disconnected()).toBe(1);
  });

  it("keeps reduced-motion scenes static while controls still work", () => {
    const test = setup("canvas", true);
    test.buttons[1]?.click();
    test.draw();
    expect(test.draws()).toBe(0);
    expect(test.panels[1]?.hidden).toBe(false);
    expect(test.frame()).toBeUndefined();
  });

  it("recovers from native drawing failure and supports repeated switching", () => {
    const test = setup("failure");
    test.buttons[1]?.click();
    test.draw();
    expect(test.scene?.dataset.renderer).toBe("dom");
    expect(test.draws()).toBe(1);
    test.buttons[0]?.click();
    expect(test.panels[0]?.hidden).toBe(false);
    expect(test.frame()).toBeUndefined();
  });
});
