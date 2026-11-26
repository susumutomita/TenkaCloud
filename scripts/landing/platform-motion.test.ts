import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { generateEnglishLanding, generatePricingPage } from "./generate-landing-locales";

const read = (file: string) =>
  readFileSync(new URL(`../../landing/${file}`, import.meta.url), "utf8");
function setup(reduced = false, rejected = false) {
  const dom = new JSDOM(read("index.html"), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let observe: (entries: { target: Element; isIntersecting: boolean }[]) => void = () => {
    /* The observer is assigned during module setup. */
  };
  let disconnected = false;
  const timers = new Map<number, () => void>();
  let next = 0;
  window.setTimeout = ((callback: () => void) => {
    timers.set(++next, callback);
    return next;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: reduced,
      addEventListener() {
        /* Preference is fixed in this fixture. */
      },
    }),
  });
  Object.defineProperty(window, "IntersectionObserver", {
    value: class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {
        /* Visibility is explicitly driven by the test. */
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  const playing = new Set<Element>();
  window.HTMLMediaElement.prototype.play = function () {
    if (rejected) return Promise.reject(new Error("autoplay unavailable"));
    playing.add(this);
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function () {
    playing.delete(this);
  };
  window.eval(read("platform-motion.js"));
  const hero = window.document.querySelector<HTMLElement>(".hero");
  const videos = [
    ...window.document.querySelectorAll<HTMLVideoElement>("video[data-ambient-video]"),
  ];
  observe(videos.map((target) => ({ target, isIntersecting: true })));
  const toggle = window.document.querySelector<HTMLButtonElement>("[data-motion-toggle]");
  return {
    dom,
    window,
    hero,
    videos,
    playing,
    timers,
    toggle,
    observe,
    disconnected: () => disconnected,
  };
}

describe("LP motion controls", () => {
  it("plays visible footage, pauses every ambient video and resumes on request", () => {
    const page = setup();
    expect(page.playing.size).toBeGreaterThan(0);
    expect(page.timers.size).toBe(1);
    page.toggle?.click();
    expect(page.playing.size).toBe(0);
    expect(page.timers.size).toBe(0);
    expect(page.window.document.documentElement.dataset.motion).toBe("paused");
    page.toggle?.click();
    expect(page.playing.size).toBeGreaterThan(0);
    page.dom.window.close();
  });
  it("starts reduced-motion with posters and no automatic scene timer", () => {
    const page = setup(true);
    expect(page.playing.size).toBe(0);
    expect(page.timers.size).toBe(0);
    expect(page.videos.every((video) => video.hasAttribute("poster"))).toBe(true);
    page.toggle?.click();
    expect(page.playing.size).toBeGreaterThan(0);
    page.dom.window.close();
  });
  it("stops offscreen work and cleans timers and observers on exit", () => {
    const page = setup();
    page.observe([...page.videos, page.hero].map((target) => ({ target, isIntersecting: false })));
    expect(page.playing.size).toBe(0);
    expect(page.timers.size).toBe(0);
    page.window.dispatchEvent(new page.window.PageTransitionEvent("pagehide"));
    expect(page.disconnected()).toBe(true);
    page.dom.window.close();
  });
  it("retains posters and usable links when autoplay is rejected", async () => {
    const page = setup(false, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.playing.size).toBe(0);
    expect(page.videos[0]?.dataset.playback).toBe("poster");
    expect(
      page.window.document.querySelector("#try .platform-entry-media")?.getAttribute("href"),
    ).toContain("portal-demo");
    page.dom.window.close();
  });
});

describe("visual entries and separate pricing", () => {
  it("preserves the local-language copy through repeated nested-span generation", () => {
    expect(generateEnglishLanding()).toBe(read("index.en.html"));
    expect(generateEnglishLanding()).toBe(generateEnglishLanding());
    const doc = new JSDOM(read("index.html")).window.document;
    expect(doc.querySelectorAll("h1 .motion-line")).toHaveLength(2);
    expect(doc.querySelector("h1")?.textContent?.match(/チーム対抗/g)).toHaveLength(1);
  });
  for (const locale of ["ja", "en"] as const) {
    const suffix = locale === "en" ? ".en" : "";
    it(`${locale} keeps real screens, accessible names and full original service terms on the separate page`, () => {
      const name = locale === "ja" ? "index.html" : "index.en.html";
      const doc = new JSDOM(read(name)).window.document;
      expect(
        doc.querySelectorAll("#try .platform-entry-media video[muted][playsinline][poster]"),
      ).toHaveLength(3);
      for (const media of doc.querySelectorAll(".platform-entry-media")) {
        expect(
          doc.getElementById(media.getAttribute("aria-labelledby") ?? "")?.textContent,
        ).toBeTruthy();
      }
      expect(
        doc.querySelector(".platform-film video[controls] source")?.getAttribute("src"),
      ).toContain("tenkacloud-60s.mp4?v=");
      const pricing = new JSDOM(generatePricingPage(locale)).window.document;
      expect(pricing.querySelectorAll(".pricing-card")).toHaveLength(3);
      expect(pricing.querySelectorAll("#offerings,#pricing,#contact")).toHaveLength(3);
      expect(pricing.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://tenkacloud.com/pricing${suffix}.html`,
      );
      expect(doc.querySelectorAll(".pricing-card")).toHaveLength(0);
      expect(
        doc
          .querySelector('.platform-price-link a[target="_blank"][rel~="noopener"]')
          ?.getAttribute("href"),
      ).toBe(`./pricing${suffix}.html`);
      expect(generatePricingPage(locale)).toBe(read(`pricing${suffix}.html`));
    });
  }
});

describe("team-specific practice is visible before individual incident examples", () => {
  for (const locale of ["ja", "en"] as const) {
    it(`${locale} labels the authoring example and links to the real author guide`, () => {
      const doc = new JSDOM(read(locale === "ja" ? "index.html" : "index.en.html")).window.document;
      const sections = [...doc.querySelectorAll("main > section")].map((section) => section.id);
      expect(sections.indexOf("custom-problems")).toBeLessThan(
        sections.indexOf("practice-question"),
      );
      const section = doc.getElementById("custom-problems");
      expect(section?.querySelector("h2")?.textContent).toMatch(/オリジナル問題|Create your own/);
      expect(section?.querySelector("figcaption")?.textContent).toMatch(
        /オリジナル問題の活用例|Ways to use your own problems/,
      );
      expect(section?.querySelectorAll("a")).toHaveLength(1);
      expect(section?.textContent).toMatch(/インシデント訓練|Incident response training/);
      expect(section?.textContent).toMatch(/オンボーディング|Onboarding new members/);
      expect(section?.textContent).toMatch(/企業ポリシー|company policy/);
      expect(section?.textContent).toMatch(/デプロイと撤収|deploy and tear down/);
      expect(section?.querySelector("a")?.getAttribute("href")).toBe(
        `./docs/manual/problem-author/${locale === "en" ? "index.en.html" : ""}`,
      );
      expect(section?.querySelectorAll("button,form")).toHaveLength(0);
      expect(doc.querySelector(".hero-secondary a")?.getAttribute("href")).toBe(
        "https://youtu.be/k3087kMJmgI",
      );
      expect(doc.querySelector(".platform-film a")?.textContent).toMatch(
        locale === "ja" ? /YouTube で見る/ : /Watch on YouTube/,
      );
      expect(doc.querySelector(".platform-film video source")?.getAttribute("src")).toContain(
        "tenkacloud-60s.mp4",
      );
    });
  }
});
