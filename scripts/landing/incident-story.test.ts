import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const root = join(import.meta.dir, "../..");
const html = readFileSync(join(root, "landing/index.html"), "utf8");
const script = readFileSync(join(root, "landing/incident-story.js"), "utf8");

function setup(mode: "unsupported" | "drawable" | "failure" = "unsupported", reduced = false) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://example.invalid/",
  });
  const { window } = dom;
  const warnings: unknown[][] = [];
  window.console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let intersection: (entries: { isIntersecting: boolean }[]) => void = (_entries) => undefined;
  let frame: (() => void) | undefined;
  let draws = 0;
  let clock = 100;
  Object.defineProperty(window.performance, "now", { value: () => clock });
  let disconnected = 0;
  let tops = [100, 1200, 2200];
  const context = {
    setTransform() {
      /* Geometry is asserted through canvas dimensions. */
    },
    clearRect() {
      /* Pixel clearing has no DOM side effects. */
    },
    save() {
      /* Stub canvas state stack. */
    },
    restore() {
      /* Stub canvas state stack. */
    },
    translate() {
      /* Pixel coordinates are not emulated by jsdom. */
    },
    rotate() {
      /* Pixel rotation is not emulated by jsdom. */
    },
    drawElementImage() {
      draws++;
      if (mode === "failure") throw new Error("paint failure");
    },
  };
  if (mode !== "unsupported")
    Object.defineProperty(window.HTMLCanvasElement.prototype, "content", { value: "drawable" });
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    value: () => (mode === "unsupported" ? {} : context),
  });
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: reduced,
      addEventListener() {
        /* Match media stays constant in this fixture. */
      },
    }),
  });
  Object.defineProperty(window, "IntersectionObserver", {
    value: class {
      constructor(callback: typeof intersection) {
        intersection = callback;
      }
      observe() {
        /* Test triggers intersection explicitly. */
      }
      disconnect() {
        disconnected++;
      }
    },
  });
  Object.defineProperty(window, "ResizeObserver", {
    value: class {
      observe() {
        /* Test triggers intersection explicitly. */
      }
      disconnect() {
        disconnected++;
      }
    },
  });
  window.requestAnimationFrame = (callback) => {
    frame = () => callback(0);
    return 1;
  };
  window.cancelAnimationFrame = () => {
    frame = undefined;
  };
  const story = window.document.querySelector<HTMLElement>(".incident-story");
  if (!story) throw new Error("Missing story");
  const canvas = story.querySelector("canvas");
  if (!canvas) throw new Error("Missing canvas");
  Object.defineProperties(canvas, { clientWidth: { value: 640 }, clientHeight: { value: 420 } });
  story.querySelectorAll("[data-step]").forEach((chapter, index) => {
    chapter.getBoundingClientRect = () => new window.DOMRect(0, tops[index], 0, 0);
  });
  window.eval(script);
  intersection([{ isIntersecting: true }]);
  const click = (selector: string) => story.querySelector<HTMLButtonElement>(selector)?.click();
  const http = () => story.querySelector("[data-http]")?.textContent;
  const scroll = (next: number[]) => {
    tops = next;
    window.dispatchEvent(new window.Event("scroll"));
  };
  const flush = () => {
    const next = frame;
    frame = undefined;
    next?.();
  };
  return {
    dom,
    window,
    story,
    canvas,
    click,
    http,
    scroll,
    flush,
    draws: () => draws,
    disconnected: () => disconnected,
    warnings,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    intersection,
  };
}

describe("incident explanation", () => {
  it("demonstrates the leak and preserves self access after the ownership fix", () => {
    const page = setup();
    expect(page.http()).toBe("200 OK");
    page.click('[data-person-select="other"]');
    expect(page.http()).toBe("200 OK");
    expect(page.story.querySelector<HTMLElement>("[data-record-other]")?.hidden).toBe(false);
    page.click("[data-fix]");
    expect(page.http()).toBe("403 Forbidden");
    expect(page.story.querySelector<HTMLElement>("[data-record-other]")?.hidden).toBe(true);
    page.click('[data-person-select="own"]');
    expect(page.http()).toBe("200 OK");
    page.click('[data-person-select="other"]');
    expect(page.http()).toBe("403 Forbidden");
    page.click("[data-reset]");
    expect(page.story.dataset.phase).toBe("0");
    expect(page.http()).toBe("200 OK");
    page.dom.window.close();
  });

  it("keeps manual actions until a new chapter and rewinds on upward scrolling", () => {
    const page = setup();
    page.click("[data-fix]");
    page.scroll([99, 1199, 2199]);
    expect(page.http()).toBe("403 Forbidden");
    page.scroll([-1500, -700, 300]);
    expect(page.story.dataset.phase).toBe("2");
    page.click("[data-reset]");
    page.scroll([-1501, -701, 299]);
    expect(page.story.dataset.phase).toBe("0");
    page.scroll([-700, 300, 1100]);
    expect(page.story.dataset.phase).toBe("1");
    page.scroll([100, 1200, 2200]);
    expect(page.story.dataset.phase).toBe("0");
    page.dom.window.close();
  });

  it("uses DOM controls when HTML-in-Canvas is unavailable", () => {
    const page = setup();
    expect(page.story.dataset.renderer).toBe("dom");
    expect(page.story.querySelector<HTMLElement>(".incident-controls")?.hidden).toBe(false);
    page.click("[data-fix]");
    expect(page.http()).toBe("403 Forbidden");
    page.dom.window.close();
  });

  it("draws a real drawable HTML subtree and bounds resolution and offscreen work", () => {
    const page = setup("drawable");
    page.flush();
    expect(page.canvas.querySelector("[drawable]")?.textContent).toContain("Aoi Example");
    expect(page.draws()).toBeGreaterThan(0);
    expect(page.canvas.width).toBeLessThanOrEqual(1400);
    expect(page.canvas.height).toBeLessThanOrEqual(1000);
    const before = page.draws();
    page.intersection([{ isIntersecting: false }]);
    page.click("[data-fix]");
    page.flush();
    expect(page.draws()).toBe(before);
    page.dom.window.close();
  });

  it("settles the native data distortion instead of keeping a perpetual render loop", () => {
    const page = setup("drawable");
    page.flush();
    page.click('[data-person-select="other"]');
    page.flush();
    const moving = page.draws();
    page.advance(900);
    page.flush();
    expect(page.draws()).toBeGreaterThan(moving);
    const settled = page.draws();
    page.flush();
    expect(page.draws()).toBe(settled);
    expect(page.http()).toBe("200 OK");
    page.click("[data-fix]");
    expect(page.http()).toBe("403 Forbidden");
    page.dom.window.close();
  });

  it("keeps a static readable final state when reduced motion is requested", () => {
    const page = setup("drawable", true);
    page.flush();
    const before = page.draws();
    page.click('[data-person-select="other"]');
    page.flush();
    expect(page.draws() - before).toBe(1);
    page.click("[data-fix]");
    page.flush();
    expect(page.http()).toBe("403 Forbidden");
    page.click('[data-person-select="own"]');
    expect(page.http()).toBe("200 OK");
    page.dom.window.close();
  });

  it("restores the DOM visual after a drawing failure", () => {
    const page = setup("failure");
    page.flush();
    expect(page.story.dataset.renderer).toBe("dom");
    expect(page.warnings).toHaveLength(1);
    page.click("[data-fix]");
    expect(page.http()).toBe("403 Forbidden");
    page.dom.window.close();
  });

  it("cleans observers on exit and preserves persisted history pages", () => {
    const page = setup();
    page.window.dispatchEvent(new page.window.PageTransitionEvent("pagehide", { persisted: true }));
    expect(page.disconnected()).toBe(0);
    page.click("[data-fix]");
    expect(page.http()).toBe("403 Forbidden");
    page.window.dispatchEvent(
      new page.window.PageTransitionEvent("pagehide", { persisted: false }),
    );
    expect(page.disconnected()).toBe(2);
    page.dom.window.close();
  });

  it("publishes readable Japanese and English explanations without JavaScript", () => {
    for (const name of ["index.html", "index.en.html"]) {
      const document = new JSDOM(readFileSync(join(root, "landing", name), "utf8")).window.document;
      expect(document.querySelectorAll(".incident-chapter")).toHaveLength(3);
      expect(document.querySelector(".incident-chapters")?.textContent).toContain("403");
      expect(document.querySelector(".incident-chapters")?.textContent).toContain("200");
      expect(document.querySelector<HTMLElement>(".incident-controls")?.hidden).toBe(true);
      expect(document.querySelector(".incident-development")?.textContent).toMatch(
        /開発中|in development/,
      );
    }
  });
});
