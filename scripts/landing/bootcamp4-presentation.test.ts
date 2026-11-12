import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { currentMediaVersions } from "./stamp-asset-versions";

const script = readFileSync("landing/tenkacloud-ug-1/talk.js", "utf8");
const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

function openDeck(path: string, hash = "") {
  const dom = new JSDOM(readFileSync(path, "utf8"), {
    url: `https://tenkacloud.com/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  windows.push(dom);
  const paused: HTMLMediaElement[] = [];
  dom.window.HTMLMediaElement.prototype.pause = function () {
    paused.push(this);
  };
  dom.window.eval(script);
  return { dom, document: dom.window.document, paused };
}

const appendixPath = "landing/ss-bootcamp4-2026-11/index.html";

test("the shared controller keeps the existing UG deck counter and keyboard controls", () => {
  const { dom, document } = openDeck("landing/tenkacloud-ug-1/index.html");
  expect(document.querySelector("#position")?.textContent).toBe("1 / 14");
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  expect(document.querySelector("#position")?.textContent).toBe("2 / 14");
  expect(document.querySelectorAll('.slide[aria-hidden="false"]')).toHaveLength(1);
});

test("the closing slide leads to a distinctly numbered Appendix and supports deep links", () => {
  const { document } = openDeck(appendixPath, "#4");
  expect(document.querySelector("#position")?.textContent).toBe("本編 4 / 4");
  document.querySelector<HTMLButtonElement>("#next")?.click();
  expect(document.querySelector("#position")?.textContent).toBe("Appendix 1 / 11");
  expect(document.querySelector(".slide:not([hidden]) h2")?.textContent).toBe("ここから Appendix");
  const last = openDeck(appendixPath, "#15");
  expect(last.document.querySelector("#position")?.textContent).toBe("Appendix 11 / 11");
  expect(last.document.querySelector<HTMLButtonElement>("#next")?.disabled).toBe(true);
  expect(last.document.querySelectorAll("#deck > .slide")).toHaveLength(15);
});

test("leaving a video slide stops media and restores the YouTube play button", () => {
  const { document, paused } = openDeck(appendixPath, "#9");
  const video = document.querySelector("video");
  expect(paused).not.toContain(video);
  document.querySelector<HTMLButtonElement>("#next")?.click();
  expect(paused).toContain(video);
  const youtube = openDeck(appendixPath, "#12");
  const play = youtube.document.querySelector<HTMLButtonElement>(".demo-play");
  expect(youtube.document.querySelector("iframe")).toBeNull();
  play?.click();
  const frame = youtube.document.querySelector("iframe");
  expect(frame?.src).toContain(
    "https://www.youtube-nocookie.com/embed/o39ZWxEbrzA?start=0&end=60&",
  );
  expect(frame?.title).toBe(play?.getAttribute("aria-label") ?? "");
  youtube.document.querySelector<HTMLButtonElement>("#next")?.click();
  expect(youtube.document.querySelector("iframe")).toBeNull();
  expect(play?.hidden).toBe(false);
});

test("slide 14 hosts the Simulator demo video and pauses it when leaving", () => {
  const { document, paused } = openDeck(appendixPath, "#14");
  const video = document.querySelector("#slide-14 video");
  const source = document.querySelector("#slide-14 video source");
  expect(document.querySelector("#slide-14")?.classList.contains("video-slide")).toBe(true);
  expect(source?.getAttribute("src")).toBe("simulator-demo.mp4");
  expect(document.querySelector("#slide-14 video")?.getAttribute("poster")).toBe(
    "simulator-demo-poster.jpg",
  );
  expect(paused).not.toContain(video);
  document.querySelector<HTMLButtonElement>("#previous")?.click();
  expect(paused).toContain(video);
});

test("slide 15 hosts the 60-second introduction shared with the LP and pauses it when leaving", () => {
  const { document, paused } = openDeck(appendixPath, "#15");
  const video = document.querySelector("#slide-15 video");
  expect(document.querySelector("#slide-15")?.classList.contains("video-slide")).toBe(true);
  const version = currentMediaVersions()["videos/lp/tenkacloud-60s.mp4"];
  expect(document.querySelector("#slide-15 video source")?.getAttribute("src")).toBe(
    `../videos/lp/tenkacloud-60s.mp4?v=${version}`,
  );
  expect(video?.getAttribute("poster")).toBe("intro-60s-poster.jpg");
  expect(document.querySelector("#slide-15 .fine")?.textContent).toContain("開発中・未リリース");
  expect(paused).not.toContain(video);
  document.querySelector<HTMLButtonElement>("#previous")?.click();
  expect(paused).toContain(video);
  expect(document.querySelector("#position")?.textContent).toBe("Appendix 10 / 11");
});
