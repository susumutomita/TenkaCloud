import { describe, expect, it } from "bun:test";
import { RECORDED_LITE_EDITS, recordedChapterStartS } from "./render-recorded-lite";
import {
  assertUnvoicedRecordedBase,
  buildCaptionOverlayFilter,
  buildCaptionOverlayHtml,
  buildVoiceoverMixFilter,
  buildWebVtt,
  captionOverlayBasename,
  localeWorkVideoPath,
  localizedVideoPath,
  normalizeEnglishForSpeech,
  normalizeJapaneseForSpeech,
  VOICEOVER_TIMELINES,
} from "./render-zundamon";
import {
  CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
  DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
} from "./voiceover-data";

// Path fixtures use `/render-work` rather than `/tmp`: the functions under test
// (`localizedVideoPath` / `localeWorkVideoPath` / `assertUnvoicedRecordedBase`) are pure
// string transforms and never touch the filesystem, so the literal only has to look like an
// absolute path — and a publicly writable one reads as a real target to a reviewer (and to
// sonarjs/publicly-writable-directories).
describe("recorded Lite Zundamon renderer", () => {
  it("should keep Japanese on the canonical URL and give English its own asset", () => {
    expect(localizedVideoPath("/render-work/deploy-tenkacloud-lite.mp4", "ja")).toBe(
      "/render-work/deploy-tenkacloud-lite.mp4",
    );
    expect(localizedVideoPath("/render-work/deploy-tenkacloud-lite.mp4", "en")).toBe(
      "/render-work/deploy-tenkacloud-lite.en.mp4",
    );
  });

  it("should render each locale from an immutable source video", () => {
    const source = "/render-work/deploy-tenkacloud-lite-source.mp4";
    const ja = localeWorkVideoPath("/render-work", "deploy-tenkacloud-lite", "ja");
    const en = localeWorkVideoPath("/render-work", "deploy-tenkacloud-lite", "en");
    expect(ja).not.toBe(source);
    expect(en).not.toBe(source);
    expect(ja).not.toBe(en);
  });

  it("should keep every slide and operation overlay filename unique", () => {
    const deployIntro = captionOverlayBasename("deploy-tenkacloud-lite", "ja", 0);
    const deployOperation = captionOverlayBasename("deploy-tenkacloud-lite", "ja", 2);
    const cleanupIntro = captionOverlayBasename("cleanup-tenkacloud-lite", "ja", 0);
    const englishIntro = captionOverlayBasename("deploy-tenkacloud-lite", "en", 0);
    expect(new Set([deployIntro, deployOperation, cleanupIntro, englishIntro]).size).toBe(4);
  });

  it("should reject a completed voice-over video as the next source", () => {
    expect(() =>
      assertUnvoicedRecordedBase("VOICEVOX:ずんだもん", "/render-work/deploy.mp4"),
    ).toThrow("Run render-recorded-lite.ts again first");
    expect(() => assertUnvoicedRecordedBase("", "/render-work/deploy.mp4")).not.toThrow();
    expect(() =>
      assertUnvoicedRecordedBase("macOS Samantha English narration", "/render-work/deploy.en.mp4"),
    ).toThrow("Run render-recorded-lite.ts again first");
  });

  it("should convert technical English labels into native TTS pronunciations", () => {
    expect(
      normalizeEnglishForSpeech(
        "TenkaCloud Lite deploys AWS with CloudFormation and CodeBuild. Verify ExternalId and the URL.",
      ),
    ).toBe(
      "Tenka Cloud Light deploys A W S with Cloud Formation and Code Build. Verify External I D and the U R L.",
    );
  });

  it("should preserve official AWS terms in captions while giving VOICEVOX Japanese pronunciations", () => {
    expect(
      normalizeJapaneseForSpeech(
        "CloudFormation stackがCodeBuild projectとIAM Roleを作り、CodeBuildがCDK deployする。",
      ),
    ).toBe(
      "クラウドフォーメーション スタックがコードビルド プロジェクトとアイエーエム ロールを作り、コードビルドがシーディーケー デプロイする。",
    );
  });

  it("should align every narration cue to the edited story", () => {
    expect(VOICEOVER_TIMELINES["deploy-tenkacloud-lite"].starts).toHaveLength(
      DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues.length,
    );
    expect(VOICEOVER_TIMELINES["cleanup-tenkacloud-lite"].starts).toHaveLength(
      CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues.length,
    );
    for (const timeline of Object.values(VOICEOVER_TIMELINES)) {
      expect(timeline.starts).toEqual([...timeline.starts].sort((a, b) => a - b));
      expect(timeline.starts.at(-1)).toBeLessThan(timeline.videoDurationS);
    }
    const deployEdit = RECORDED_LITE_EDITS[0];
    const deployStarts = VOICEOVER_TIMELINES["deploy-tenkacloud-lite"].starts;
    expect(deployStarts[0]).toBeCloseTo(recordedChapterStartS(deployEdit, "intro") + 0.2);
    expect(deployStarts[1]).toBeCloseTo(recordedChapterStartS(deployEdit, "setup-explainer") + 0.2);
    expect(deployStarts[2]).toBeCloseTo(recordedChapterStartS(deployEdit, "launcher") + 0.3);
    expect(deployStarts[3]).toBeCloseTo(recordedChapterStartS(deployEdit, "deploy") + 0.2);
    expect(deployStarts[4]).toBeCloseTo(recordedChapterStartS(deployEdit, "admin-sign-in") + 0.2);

    const cleanupEdit = RECORDED_LITE_EDITS[1];
    const cleanupStarts = VOICEOVER_TIMELINES["cleanup-tenkacloud-lite"].starts;
    expect(cleanupStarts[0]).toBeCloseTo(recordedChapterStartS(cleanupEdit, "cleanup-intro") + 0.2);
    expect(cleanupStarts[1]).toBeCloseTo(recordedChapterStartS(cleanupEdit, "cleanup-order") + 0.2);
    expect(cleanupStarts[2]).toBeCloseTo(
      recordedChapterStartS(cleanupEdit, "cleanup-action") + 0.3,
    );
    expect(cleanupStarts[5]).toBeCloseTo(
      recordedChapterStartS(cleanupEdit, "cleanup-complete") + 0.2,
    );
  });

  it("should generate valid bilingual WebVTT without leaking checkpoint values", () => {
    const script = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER;
    const timeline = VOICEOVER_TIMELINES["deploy-tenkacloud-lite"];
    const ja = buildWebVtt(script.cues, "ja", timeline.starts, timeline.videoDurationS);
    const en = buildWebVtt(script.cues, "en", timeline.starts, timeline.videoDurationS);

    expect(ja).toStartWith("WEBVTT\n");
    expect(ja).toContain("00:00:00.200 --> 00:00:08.700");
    expect(ja).toContain("全体の流れを見る");
    expect(`${ja}${en}`).not.toContain("AdministratorAccess");
    expect(`${ja}${en}`).not.toMatch(/TENKA\{[A-Z0-9-]+\}/);
  });

  it("should open with a full-screen localized product-definition card", () => {
    const cue = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues[0];
    const html = buildCaptionOverlayHtml(cue, "ja", 0, 10);
    expect(html).toContain("TENKACLOUD LITE · AWS DEPLOYMENT");
    expect(html).toContain("自分のAWS環境へデプロイ");
    expect(html).toContain("LiteをAWSへ導入");
    expect(html).toContain("競技用AWSを登録");
    expect(html).toContain("イベントを作成・Deploy");
    expect(html).toContain("Participant Portal・スコア");
    expect(html).toContain("tenkacloud-lite-problem-deploy");
    expect(html).not.toContain("AdministratorAccess");
    expect(html).not.toContain("STEP 1 / 10");
  });

  it("should explain the AWS services before the first real AWS operation", () => {
    const cue = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues.find(
      (candidate) => candidate.layout === "start",
    );
    expect(cue).toBeDefined();
    if (!cue) throw new Error("expected a start cue");
    const html = buildCaptionOverlayHtml(cue, "ja", 1, 13);
    expect(html).toContain("START HERE · THEN THE REAL AWS CONSOLE");
    expect(html).toContain("AWSの自動デプロイとは");
    expect(html).toContain("CloudFormation stack: ひな形からAWSリソースを作る");
    expect(html).toContain("CodeBuild project: make deploy / CDK deployを実行");
    expect(html).toContain("IAM Role: ServiceRoleとして実行権限を付与");
    expect(html).toContain("S3");
    expect(html).toContain("CloudFront");
    expect(html).toContain("Cognito");
    expect(html).toContain("Lambda");
    expect(html).toContain("API Gateway");
    expect(html).toContain("DynamoDB");
    expect(html).toContain("Next: actual screen operation");
  });

  it("should explain why before returning to later real AWS operations", () => {
    const cue = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues.find(
      (candidate) => candidate.layout === "explainer",
    );
    expect(cue).toBeDefined();
    if (!cue) throw new Error("expected an explainer cue");
    const html = buildCaptionOverlayHtml(cue, "ja", 1, 13);
    expect(html).toContain("WHY THIS STEP · THEN THE REAL AWS CONSOLE");
    expect(html).toContain("なぜ競技用AWSを分けるのか");
    expect(html).toContain("Next: actual screen operation");
  });

  it("should render cleanup-specific flow, reason, and completion slides", () => {
    const [intro, order, , , , complete] = CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues;
    if (!intro || !order || !complete) throw new Error("expected complete cleanup story");

    const introHtml = buildCaptionOverlayHtml(intro, "ja", 0, 6);
    expect(introHtml).toContain("TENKACLOUD LITE · AWS CLEANUP");
    expect(introHtml).toContain("CodeBuildでLite本体を削除");
    expect(introHtml).toContain("launcherを最後に削除");

    const orderHtml = buildCaptionOverlayHtml(order, "ja", 1, 6);
    expect(orderHtml).toContain("WHY THIS ORDER · THEN THE REAL AWS CONSOLE");
    expect(orderHtml).toContain("復旧経路");

    const completeHtml = buildCaptionOverlayHtml(complete, "ja", 5, 6);
    expect(completeHtml).toContain("CLEANUP COMPLETE · VERIFY IN AWS");
    expect(completeHtml).toContain("削除完了を確認");
    expect(completeHtml).toContain("AWSの請求");
  });

  it("should burn an always-visible step heading, note, and caption over recorded operations", () => {
    const cue = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues.find(
      (candidate) => candidate.layout === undefined && candidate.note !== undefined,
    );
    expect(cue).toBeDefined();
    if (!cue) throw new Error("expected an operation cue with a note");
    const html = buildCaptionOverlayHtml(cue, "ja", 0, 9);
    expect(html).toContain("STEP 1 / 9");
    expect(html).toContain(cue.heading.ja);
    expect(html).toContain(cue.ja);
    expect(html).toContain("AdministratorAccess");
    expect(html).toContain("background: transparent");

    const filter = buildCaptionOverlayFilter([0.3, 12.5], 3, 24);
    expect(filter).toContain("[0:v][3:v]overlay=0:0:enable='between(t,0.300,12.300)'");
    expect(filter).toContain("format=yuv420p[vout]");
  });

  it("should explain destroy-all without showing the obsolete cleanup form", () => {
    const action = CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER.cues[2];
    if (!action) throw new Error("expected cleanup action cue");
    const html = buildCaptionOverlayHtml(action, "ja", 0, 3);
    expect(html).toContain("WHY THIS ORDER · THEN THE REAL AWS CONSOLE");
    expect(html).toContain("ACTION=destroy-all");
    expect(html).toContain("DynamoDB");
    expect(html).toContain("CloudWatch Logs");
  });

  it("should delay, mix, normalize, and trim synthesized cue audio", () => {
    const filter = buildVoiceoverMixFilter([0.3, 8], [6, 7], 16);
    expect(filter).toContain("adelay=300|300");
    expect(filter).toContain("amix=inputs=2:duration=longest:normalize=0");
    expect(filter).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(filter).toContain("atrim=duration=16.000[aout]");
  });

  it("should reject narration that would need an unnatural speed-up", () => {
    expect(() => buildVoiceoverMixFilter([0, 5], [8, 4], 10)).toThrow(
      "Narration cue 0 exceeds its slot",
    );
  });
});
