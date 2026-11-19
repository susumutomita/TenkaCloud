import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (name: string) =>
  readFileSync(new URL(`../../landing/${name}`, import.meta.url), "utf8");
function setup({ reduced = false, unsupported = false, canvas = true } = {}) {
  const dom = new JSDOM(read("index.html"), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://tenkacloud.example/",
  });
  const { window } = dom;
  const jobs: { complete: () => void; cancelled: boolean }[] = [];
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: reduced,
      addEventListener() {
        /* Fixed test preference. */
      },
    }),
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    value: () =>
      canvas
        ? {
            fillRect() {
              /* No pixel rendering in DOM tests. */
            },
            drawImage() {
              /* Actual rendering is covered by visual QA. */
            },
          }
        : null,
  });
  for (const video of window.document.querySelectorAll("video")) {
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    video.getBoundingClientRect = () => new window.DOMRect(0, 0, 2400, 1600);
  }
  if (!unsupported)
    Object.defineProperty(window.Element.prototype, "animate", {
      value: () => {
        let complete = () => {
          /* Assigned by the promise executor. */
        };
        const finished = new Promise<void>((resolve) => {
          complete = resolve;
        });
        const job = { complete, cancelled: false };
        jobs.push(job);
        return {
          finished,
          cancel: () => {
            job.cancelled = true;
            complete();
          },
        };
      },
    });
  const resizes: ((entries: { contentRect: { width: number; height: number } }[]) => void)[] = [];
  Object.defineProperty(window, "ResizeObserver", {
    value: class {
      constructor(callback: (typeof resizes)[number]) {
        resizes.push(callback);
      }
      observe() {
        /* Resize notifications are driven explicitly. */
      }
      disconnect() {
        /* No native resources in this fixture. */
      }
    },
  });
  window.eval(read("entry-scenes.js"));
  const root = window.document.querySelector<HTMLElement>("#try");
  if (!root) throw new Error("Missing entry gallery");
  const choose = (index: number) => {
    const input = root.querySelector<HTMLInputElement>(`input[value="${index}"]`);
    if (!input) throw new Error("Missing native radio");
    input.checked = true;
    input.dispatchEvent(new window.Event("change"));
  };
  return { dom, window, root, jobs, choose, resizes };
}

describe("entry screen selection and motion", () => {
  it("changes the selected semantic screen immediately and keeps independent galleries independent", () => {
    const page = setup();
    page.choose(1);
    expect(page.root.dataset.entryScene).toBe("1");
    expect(page.root.querySelectorAll("[data-entry-current]")).toHaveLength(1);
    expect(page.root.querySelector<HTMLElement>('[data-entry-panel="0"]')?.hidden).toBeTruthy();
    expect(page.root.querySelector<HTMLElement>('[data-entry-panel="1"]')?.hidden).toBe(false);
    expect(
      page.window.document.querySelector<HTMLElement>("#how-it-works")?.dataset.entryScene,
    ).toBe("0");
    expect(page.root.querySelector("[data-entry-current] a")?.getAttribute("href")).toContain(
      "problems",
    );
    page.window.close();
  });
  it("uses bounded snapshots, removes old animations on repeated selections, and settles at the latest screen", async () => {
    const page = setup();
    page.choose(1);
    expect(page.root.querySelectorAll("[data-transition-layer] canvas")).toHaveLength(8);
    for (const canvas of page.root.querySelectorAll<HTMLCanvasElement>(
      "[data-transition-layer] canvas",
    )) {
      expect(canvas.width * 8).toBeLessThanOrEqual(1032);
      expect(canvas.height).toBeLessThanOrEqual(640);
    }
    const old = [...page.jobs];
    page.choose(2);
    expect(old.every((job) => job.cancelled)).toBe(true);
    expect(page.root.querySelectorAll("[data-transition-layer]")).toHaveLength(1);
    page.jobs.forEach((job) => {
      job.complete();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.root.querySelectorAll("[data-transition-layer]")).toHaveLength(0);
    expect(page.root.dataset.entryScene).toBe("2");
    page.window.close();
  });
  for (const mode of ["reduced", "unsupported", "paused"] as const) {
    it(`${mode} selects the same destination without animation`, () => {
      const page = setup({ reduced: mode === "reduced", unsupported: mode === "unsupported" });
      if (mode === "paused") page.window.document.documentElement.dataset.motion = "paused";
      page.choose(1);
      expect(page.root.dataset.entryScene).toBe("1");
      expect(page.jobs).toHaveLength(0);
      expect(page.root.querySelectorAll("[data-transition-layer]")).toHaveLength(0);
      page.window.close();
    });
  }
  it("keeps motion on content-height changes and cancels when the gallery width changes", () => {
    const page = setup();
    page.choose(1);
    page.resizes[1]?.([{ contentRect: { width: 0, height: 900 } }]);
    expect(page.root.querySelector("[data-entry-stage]")?.getAttribute("data-transition")).toBe(
      "moving",
    );
    page.resizes[1]?.([{ contentRect: { width: 390, height: 900 } }]);
    expect(page.root.querySelectorAll("[data-transition-layer]")).toHaveLength(0);
    expect(page.jobs.every((job) => job.cancelled)).toBe(true);
    page.window.close();
  });
  it("falls back to the real poster when canvas capture is unavailable and pauses cleanly", () => {
    const page = setup({ canvas: false });
    page.choose(1);
    expect(page.root.querySelector('[data-snapshot="poster"] video[poster]')).not.toBeNull();
    expect(page.root.querySelector("[data-snapshot] video")?.hasAttribute("src")).toBe(false);
    page.window.document.documentElement.dataset.motion = "paused";
    page.window.document.dispatchEvent(new page.window.Event("tenka:motion"));
    expect(page.root.querySelectorAll("[data-transition-layer]")).toHaveLength(0);
    expect(page.jobs.every((job) => job.cancelled)).toBe(true);
    page.window.close();
  });
  it("reveals find/hash destinations, prints every screen, and restores the reader’s selection", () => {
    const page = setup();
    page.window.location.hash = "security-minigames";
    page.window.dispatchEvent(new page.window.Event("hashchange"));
    expect(page.root.dataset.entryScene).toBe("1");
    page.window.dispatchEvent(new page.window.Event("beforeprint"));
    expect(
      [...page.root.querySelectorAll<HTMLElement>("[data-entry-panel]")].every(
        (panel) => !panel.hidden,
      ),
    ).toBe(true);
    page.window.dispatchEvent(new page.window.Event("afterprint"));
    expect(page.root.querySelector<HTMLElement>('[data-entry-panel="0"]')?.hidden).toBeTruthy();
    page.root
      .querySelector('[data-entry-panel="2"]')
      ?.dispatchEvent(new page.window.Event("beforematch"));
    expect(page.root.dataset.entryScene).toBe("2");
    page.window.close();
  });
  it("explains Simulator’s subset and leaves the approved legal and pricing details intact", () => {
    const doc = new JSDOM(read("index.html")).window.document;
    expect(doc.querySelector("#how-it-works")?.textContent).toContain("TenkaCloud Simulator");
    expect(doc.querySelector("#how-it-works")?.textContent).toContain("対応APIは一部");
    expect(doc.querySelector(".hero .hero-trust")).toBeNull();
    expect(doc.querySelector("footer")?.textContent).toContain("Apache License 2.0");
    expect(doc.querySelector("#try h2")?.textContent).not.toContain("今、試せること");
    expect(doc.querySelector("#try .platform-price-link")).toBeNull();
    expect(doc.querySelector('.platform-price-link a[target="_blank"]')?.getAttribute("href")).toBe(
      "./pricing.html",
    );
  });
});
