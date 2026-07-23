import { describe, expect, it } from "bun:test";
import {
  buildSocialShortFilterGraph,
  buildSocialShortOverlayHtml,
  DEPLOY_SOCIAL_SHORT_SEGMENTS,
  SOCIAL_SHORT_PHASES,
  socialShortDurationS,
} from "./render-social-short";

describe("TenkaCloud Lite social short renderer", () => {
  it("should keep the complete Lite journey in causal order", () => {
    expect(DEPLOY_SOCIAL_SHORT_SEGMENTS.map((segment) => segment.chapter)).toEqual([
      "intro",
      "services",
      "cloudformation",
      "codebuild",
      "competitor",
      "event-reason",
      "event-create",
      "event-deploy",
      "participant",
      "play",
      "score",
    ]);
  });

  it("should fit the shared X, Instagram Reels, and YouTube Shorts duration", () => {
    expect(socialShortDurationS(DEPLOY_SOCIAL_SHORT_SEGMENTS)).toBeGreaterThanOrEqual(28);
    expect(socialShortDurationS(DEPLOY_SOCIAL_SHORT_SEGMENTS)).toBeLessThanOrEqual(30);
  });

  it("should render a 9:16 composition without cropping the foreground AWS recording", () => {
    const graph = buildSocialShortFilterGraph();
    expect(graph).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(graph).toContain("crop=1080:1920");
    expect(graph).toContain("scale=1080:-2");
    expect(graph).toContain("overlay=(W-w)/2:(H-h)/2");
  });

  it("should make every time jump deliberate in video and audio", () => {
    const graph = buildSocialShortFilterGraph();
    expect(graph.match(/xfade=/g)).toHaveLength(DEPLOY_SOCIAL_SHORT_SEGMENTS.length - 1);
    expect(graph.match(/acrossfade=/g)).toHaveLength(DEPLOY_SOCIAL_SHORT_SEGMENTS.length - 1);
    expect(graph.match(/overlay=/g)).toHaveLength(SOCIAL_SHORT_PHASES.length + 1);
  });

  it("should provide large localized story labels without leaking tutorial answers", () => {
    const japanese = SOCIAL_SHORT_PHASES.map((_, index) =>
      buildSocialShortOverlayHtml("ja", index),
    ).join("\n");
    const english = SOCIAL_SHORT_PHASES.map((_, index) =>
      buildSocialShortOverlayHtml("en", index),
    ).join("\n");

    expect(japanese).toContain("自分のAWSへLiteをデプロイ");
    expect(japanese).toContain("イベントを作成・Deploy");
    expect(japanese).toContain("フル動画はYouTubeへ");
    expect(english).toContain("Deploy Lite to your AWS");
    expect(english).toContain("Create and deploy an event");
    expect(english).toContain("Watch the full tutorial on YouTube");
    expect(`${japanese}\n${english}`).not.toMatch(/(?:TC|TENKA)\{/);
  });
});
