import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type DOMWindow, JSDOM } from "jsdom";
import { assetVersion } from "./stamp-asset-versions";

const read = (name: string) =>
  readFileSync(new URL(`../../landing/${name}`, import.meta.url), "utf8");

function assertClickTargets(window: DOMWindow, gallery: Element) {
  for (const panel of gallery.querySelectorAll<HTMLElement>("[data-entry-panel]")) {
    const current = panel.hasAttribute("data-entry-current");
    expect(window.getComputedStyle(panel).pointerEvents).toBe(current ? "auto" : "none");
    if (!current) continue;
    const anchor = panel.querySelector("a");
    if (!anchor) throw new Error("Current exercise screen must have a usable link");
    expect(window.getComputedStyle(anchor).pointerEvents).toBe("auto");
  }
}

describe("clickable exercise scenes and clear first impressions", () => {
  it("never lets hidden-until-found panels intercept a selected link", () => {
    const dom = new JSDOM(read("index.html"), { runScripts: "outside-only" });
    const { window } = dom;
    const style = window.document.createElement("style");
    style.textContent = read("styles/platform.css");
    window.document.head.append(style);
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: true,
        addEventListener() {
          /* Fixed reduced-motion fixture. */
        },
      }),
    });
    window.eval(read("entry-scenes.js"));
    for (const gallery of window.document.querySelectorAll("[data-entry-gallery]")) {
      for (const input of gallery.querySelectorAll<HTMLInputElement>("input")) {
        input.checked = true;
        input.dispatchEvent(new window.Event("change"));
        assertClickTargets(window, gallery);
      }
    }
    window.close();
  });
  for (const name of ["index.html", "index.en.html"]) {
    it(`${name} leads with the real film and leaves only a pricing link`, () => {
      const doc = new JSDOM(read(name)).window.document;
      const sections = [...doc.querySelectorAll("main > section")].map((e) => e.id);
      expect(sections.slice(0, 3)).toEqual(["platform", "film", "how-it-works"]);
      expect(doc.querySelector(".hero .platform-primary")?.getAttribute("href")).toBe("#film");
      expect(doc.querySelectorAll("video[controls]")).toHaveLength(1);
      expect(doc.querySelector("#film video source")?.getAttribute("src")).toContain(
        "tenkacloud-60s.mp4?v=",
      );
      expect(doc.querySelector("#support")).toBeNull();
      expect(doc.querySelectorAll(".pricing-card")).toHaveLength(0);
      expect(
        doc.querySelector('.platform-price-link a[target="_blank"]')?.getAttribute("href"),
      ).toContain("pricing");
      for (const selector of [
        "#workflow-title",
        "#try-title",
        "#hosting > .wrap > h2",
        ".platform-final h2",
      ]) {
        expect(doc.querySelector(selector)?.textContent).not.toMatch(
          /問題を選ぶ。操作する|操作デモ・ゲーム|一人でも、チームでも|まずは、TenkaCloud の流れ/,
        );
      }
    });
  }
});

it("keeps every primary English heading translated after copy changes", () => {
  const doc = new JSDOM(read("index.en.html")).window.document;
  for (const selector of [
    ".hero h1",
    "#film-title",
    "#workflow-title",
    "#why h2",
    "#try-title",
    "#hosting > .wrap > h2",
    ".platform-final h2",
  ]) {
    const heading = doc.querySelector(selector)?.textContent;
    expect(heading).toBeTruthy();
    expect(heading).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
  }
});

describe("pricing redesign preserves service commitments", () => {
  for (const suffix of ["", ".en"]) {
    it(`pricing${suffix} retains all plans, terms, accessible links and current assets`, () => {
      const doc = new JSDOM(read(`pricing${suffix}.html`)).window.document;
      expect(doc.querySelectorAll(".pricing-card")).toHaveLength(3);
      expect(doc.querySelectorAll("#plan-starter,#plan-standard,#plan-enterprise")).toHaveLength(3);
      const plans = [...doc.querySelectorAll(".pricing-card")];
      expect(
        plans.every(
          (p) =>
            p.querySelector('a[target="_blank"][rel~="noopener"]')?.getAttribute("href") ===
            "https://forms.gle/djVprYmq3hFgJA7P9",
        ),
      ).toBe(true);
      expect(doc.querySelector('a[href="#pricing"]')).not.toBeNull();
      expect(doc.querySelector('a[href="#offerings"]')).not.toBeNull();
      for (const asset of ["styles/pricing.css", "pricing-page.js"]) {
        expect(doc.documentElement.outerHTML).toContain(
          `./${asset}?v=${assetVersion(read(asset))}`,
        );
      }
      if (!suffix) {
        const copy = [
          ...doc.querySelectorAll(
            '[data-i18n^="pricing."],[data-i18n^="offerings."],[data-i18n^="ent."]',
          ),
        ]
          .map((e) => [e.getAttribute("data-i18n"), e.innerHTML])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"));
        expect(createHash("sha256").update(JSON.stringify(copy)).digest("hex")).toBe(
          "bebde6777062bd04c5cbf6197752381cfcd3ac07392003fb29e013401ffdd4fa",
        );
      }
    });
  }
});

function pricingMotion(reduced = false, supported = true) {
  const dom = new JSDOM(read("pricing.html"), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let notify: (entries: { target: Element; isIntersecting: boolean }[]) => void = () => {
    /* Set by observer construction. */
  };
  let preferenceChanged = () => {
    /* Set by matchMedia subscription. */
  };
  let disconnected = false;
  const observed: Element[] = [];
  const jobs: { cancelled: boolean }[] = [];
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: reduced,
      addEventListener: (_event: string, callback: () => void) => {
        preferenceChanged = callback;
      },
    }),
  });
  Object.defineProperty(window, "IntersectionObserver", {
    value: class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe(node: Element) {
        observed.push(node);
      }
      unobserve() {
        /* Native delivery stops after this call. */
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  if (supported)
    Object.defineProperty(window.Element.prototype, "animate", {
      value: () => {
        const job = { cancelled: false };
        jobs.push(job);
        return {
          finished: Promise.resolve(),
          cancel: () => {
            job.cancelled = true;
          },
        };
      },
    });
  window.eval(read("pricing-page.js"));
  notify(observed.map((target) => ({ target, isIntersecting: true })));
  return { dom, window, jobs, observed, preferenceChanged, disconnected: () => disconnected };
}
describe("pricing motion is optional and leaves financial content readable", () => {
  it("animates the introduction and plans once visible, and cleans up on departure", () => {
    const page = pricingMotion();
    expect(page.observed).toHaveLength(4);
    expect(page.jobs).toHaveLength(4);
    page.window.dispatchEvent(new page.window.PageTransitionEvent("pagehide"));
    expect(page.jobs.every((job) => job.cancelled)).toBe(true);
    expect(page.disconnected()).toBe(true);
    expect(page.window.document.querySelectorAll("[hidden]")).toHaveLength(0);
    page.window.close();
  });
  for (const mode of ["reduced", "unsupported"])
    it(`${mode} keeps all plans visible without animations`, () => {
      const page = pricingMotion(mode === "reduced", mode !== "unsupported");
      expect(page.jobs).toHaveLength(0);
      expect(page.window.document.querySelectorAll(".pricing-card")).toHaveLength(3);
      expect(page.window.document.querySelectorAll("[hidden]")).toHaveLength(0);
      page.window.close();
    });
});
