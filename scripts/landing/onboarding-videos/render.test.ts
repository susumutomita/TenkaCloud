import { describe, expect, it } from "bun:test";
import {
  buildFilterGraph,
  buildSlideHtml,
  escapeHtml,
  FADE_S,
  videoNominalDurationS,
} from "./render";
import { LP_VIDEO, ONBOARDING_VIDEOS } from "./script-data";

/**
 * #2707 P1: 動画は生成物 (mp4) を CI で検証できないので、 台本と組み立てロジックの
 * 構造契約をここで機械検証する。 fixture の videoUrl (dev-mock-fixtures.test.ts) と
 * この problemId 一覧が揃っていることが「スロットに実体がある」ことの担保になる。
 */

describe("onboarding video scripts (#2707)", () => {
  it("should ship exactly the trilogy videos, named after their fixture problemIds", () => {
    expect(ONBOARDING_VIDEOS.map((v) => v.problemId)).toEqual([
      "what-is-tenkacloud",
      "play-local-mode",
      "deploy-tenkacloud-lite",
    ]);
  });

  it("should keep every video inside the one-minute budget (48-65s nominal)", () => {
    for (const video of ONBOARDING_VIDEOS) {
      const nominal = videoNominalDurationS(video);
      const fades = (video.slides.length - 1) * FADE_S;
      expect(nominal, `${video.problemId} nominal`).toBeGreaterThanOrEqual(48);
      expect(nominal, `${video.problemId} nominal`).toBeLessThanOrEqual(65);
      expect(nominal - fades, `${video.problemId} effective`).toBeLessThanOrEqual(60);
    }
  });

  it("should open with INTRO, close with GOAL, and caption every slide bilingually", () => {
    for (const video of [...ONBOARDING_VIDEOS, LP_VIDEO]) {
      expect(video.slides[0]?.badge).toBe("INTRO");
      expect(video.slides.at(-1)?.badge).toBe("GOAL");
      for (const slide of video.slides) {
        expect(slide.titleJa.length, `${video.problemId}/${slide.badge}`).toBeGreaterThan(0);
        expect(slide.titleEn.length, `${video.problemId}/${slide.badge}`).toBeGreaterThan(0);
        expect(slide.bulletsJa?.length ?? 0).toBe(slide.bulletsEn?.length ?? 0);
      }
    }
  });

  it("should never reveal a real checkpoint code in a slide", () => {
    for (const video of [...ONBOARDING_VIDEOS, LP_VIDEO]) {
      for (const slide of video.slides) {
        const text = JSON.stringify(slide);
        // 実値 TENKA{...} は実環境の画面にだけ現れる。 動画に出すとドリルのネタバレになる。
        expect(text, `${video.problemId}/${slide.badge}`).not.toMatch(/TENKA\{[A-Z0-9-]+\}/);
      }
    }
  });
});

describe("slide HTML builder", () => {
  const video = ONBOARDING_VIDEOS[0];

  it("should escape markup in the copy", () => {
    expect(escapeHtml('<b>"A & B"</b>')).toBe("&lt;b&gt;&quot;A &amp; B&quot;&lt;/b&gt;");
  });

  it("should render title, subtitle, badge, and progress for a slide", () => {
    const html = buildSlideHtml(video, video.slides[1], 1, video.slides.length);
    expect(html).toContain(video.slides[1].titleJa);
    expect(html).toContain(video.slides[1].titleEn);
    expect(html).toContain(`>${video.slides[1].badge}<`);
    expect([...html.matchAll(/class="seg on"/g)]).toHaveLength(2);
    expect(html).toContain(`2 / ${video.slides.length}`);
  });
});

describe("ffmpeg filter graph builder", () => {
  it("should chain xfades with cumulative offsets that subtract prior fades", () => {
    const graph = buildFilterGraph([7, 7, 8]);
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=6.50");
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=13.00");
    expect(graph).toContain("[vx]format=yuv420p[vout]");
    expect([...graph.matchAll(/zoompan=/g)]).toHaveLength(3);
  });

  it("should degrade to a single formatted stream for one slide", () => {
    const graph = buildFilterGraph([10]);
    expect(graph).toContain("[v0]format=yuv420p[vout]");
    expect(graph).not.toContain("xfade");
  });
});

describe("LP 30-second product video (#2696 P1)", () => {
  it("should stay within 30 seconds effective and keep the 2-CTA closing slide", () => {
    const nominal = videoNominalDurationS(LP_VIDEO);
    const fades = (LP_VIDEO.slides.length - 1) * FADE_S;
    expect(nominal - fades).toBeLessThanOrEqual(30);
    expect(LP_VIDEO.problemId).toBe("tenkacloud-30s");
    const closing = LP_VIDEO.slides.at(-1);
    expect(closing?.bulletsJa).toHaveLength(2);
    expect(closing?.titleJa).toContain("tenkacloud.com");
  });

  it("should build portrait slides with the vertical layout overrides", () => {
    const html = buildSlideHtml(
      LP_VIDEO,
      LP_VIDEO.slides[0],
      0,
      LP_VIDEO.slides.length,
      "portrait",
    );
    expect(html).toContain("width: 720px; height: 1280px;");
    expect(html).toContain(".vtitle { display: none; }");
    const graph = buildFilterGraph([4.5, 5.5], "portrait");
    expect(graph).toContain("crop=1440:2560:0:0");
    expect(graph).toContain("s=720x1280");
  });
});
