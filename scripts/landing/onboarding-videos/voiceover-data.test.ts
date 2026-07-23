import { describe, expect, it } from "bun:test";
import {
  CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
  DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
} from "./voiceover-data";

describe("deploy-tenkacloud-lite Zundamon voice-over", () => {
  const script = DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER;

  it("should provide Japanese and English lines for every edit cue", () => {
    expect(script.id).toBe("deploy-tenkacloud-lite-zundamon");
    expect(script.title.ja).toContain("TenkaCloud Lite");
    expect(script.title.en).toContain("TenkaCloud Lite");
    expect(script.voice.ja).toContain("VOICEVOX:ずんだもん");
    expect(script.voice.en).toContain("Samantha");
    expect(script.voice.en).not.toContain("VOICEVOX");

    for (const cue of script.cues) {
      expect(cue.heading.ja, cue.section).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(cue.heading.en, cue.section).toMatch(/[A-Za-z]/);
      expect(cue.ja, cue.section).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(cue.en, cue.section).toMatch(/[A-Za-z]/);
      expect(cue.targetS, cue.section).toBeGreaterThanOrEqual(3);
      expect(cue.targetS, cue.section).toBeLessThanOrEqual(10);
    }
  });

  it("should cover deploy without mixing in cleanup or leaking checkpoint values", () => {
    const joined = JSON.stringify(script);

    expect(joined).toContain("CodeBuild");
    expect(joined).not.toContain("ACTION=destroy");
    expect(joined).not.toContain("checkpoint");
    expect(joined).not.toContain("成功コード");
    expect(joined).not.toContain("作成コード");
    expect(joined).not.toMatch(/TENKA\{[A-Z0-9-]+\}/);
  });

  it("should define Lite from the deployed architecture before mentioning permissions", () => {
    const [intro, launcher, ...rest] = script.cues;
    const introText = JSON.stringify(intro);
    const laterText = JSON.stringify([launcher, ...rest]);

    expect(intro.layout).toBe("intro");
    expect(introText).toContain("一人の主催者");
    expect(introText).toContain("自分の AWS 環境");
    expect(introText).toContain("tenkacloud-lite");
    expect(introText).toContain("tenkacloud-lite-problem-deploy");
    expect(introText).not.toContain("AdministratorAccess");
    expect(laterText).toContain("AdministratorAccess");
  });

  it("should explain the AWS services before showing the deployment operations", () => {
    const start = script.cues[1];
    const setup = script.cues[2];
    const build = script.cues[3];

    expect(start?.layout).toBe("start");
    expect(start?.heading.ja).toContain("AWSの自動デプロイ");
    expect(start?.ja).toContain("CloudFormation stack");
    expect(start?.ja).toContain("CodeBuild");
    expect(start?.ja).toContain("CDK deploy");
    expect(start?.details?.ja).toContain("CloudFormation stack: ひな形からAWSリソースを作る");
    expect(start?.details?.ja).toContain("CodeBuild project: make deploy / CDK deployを実行");
    expect(start?.details?.ja).toContain("IAM Role: ServiceRoleとして実行権限を付与");
    for (const service of ["S3", "CloudFront", "Cognito", "Lambda", "API Gateway", "DynamoDB"]) {
      expect(start?.note?.ja).toContain(service);
    }

    expect(setup?.heading.ja).toContain("自動デプロイ環境を作成");
    expect(setup?.note?.ja).toContain("tenkacloud-lite-launcher");
    expect(build?.heading.ja).toContain("自動デプロイを開始");
    expect(build?.ja).toContain("Start build");
  });

  it("should explain that event deploy creates the problem in competitor AWS", () => {
    const eventDeploy = script.cues.find((cue) => cue.section.includes("Event deployment"));
    expect(eventDeploy?.note?.ja).toContain("競技用AWS");
    expect(eventDeploy?.note?.ja).toContain("CloudFormation CreateStack");
    expect(eventDeploy?.note?.en).toContain("competitor AWS");
  });

  it("should fit a short LP/problem video narration budget", () => {
    const totalTargetS = script.cues.reduce((sum, cue) => sum + cue.targetS, 0);

    expect(totalTargetS).toBeLessThanOrEqual(90);
  });
});

describe("cleanup-tenkacloud-lite Zundamon voice-over", () => {
  const script = CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER;

  it("should provide Japanese and English lines for cleanup-only footage", () => {
    expect(script.id).toBe("cleanup-tenkacloud-lite-zundamon");
    expect(script.cues).toHaveLength(6);
    expect(script.voice.en).toContain("Samantha");
    expect(script.voice.en).not.toContain("VOICEVOX");
    expect(script.music).toContain("Cat_life.mp3");
    expect(script.music).toContain("GT-K");
    for (const cue of script.cues) {
      expect(cue.heading.ja, cue.section).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(cue.heading.en, cue.section).toMatch(/[A-Za-z]/);
      expect(cue.ja, cue.section).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(cue.en, cue.section).toMatch(/[A-Za-z]/);
      expect(cue.targetS, cue.section).toBeGreaterThanOrEqual(3);
      expect(cue.targetS, cue.section).toBeLessThanOrEqual(10);
    }
  });

  it("should cover both cleanup actions without leaking checkpoint values", () => {
    const joined = JSON.stringify(script);

    expect(joined).toContain("ACTION=destroy");
    expect(joined).toContain("launcher");
    expect(joined).not.toContain("checkpoint");
    expect(joined).not.toContain("成功コード");
    expect(joined).not.toContain("控えたコード");
    expect(joined).not.toMatch(/TENKA\{[A-Z0-9-]+\}/);
  });

  it("should teach the cleanup flow and explain why the launcher is deleted last", () => {
    const [intro, order, action, wait, launcher, complete] = script.cues;

    expect(intro?.layout).toBe("intro");
    expect(intro?.details?.ja).toEqual([
      "1  CodeBuildでLite本体を削除",
      "2  削除成功を確認",
      "3  launcherを最後に削除",
    ]);
    expect(order?.layout).toBe("explainer");
    expect(order?.heading.ja).toContain("launcherを最後");
    expect(order?.ja).toContain("復旧経路");
    expect(action?.ja).toContain("ACTION=destroy");
    expect(action?.captionPlacement).toBe("top-right");
    expect(wait?.ja).toContain("tenkacloud-lite");
    expect(wait?.ja).toContain("tenkacloud-lite-problem-deploy");
    expect(launcher?.ja).toContain("CloudFormation");
    expect(launcher?.ja).toContain("CodeBuild");
    expect(launcher?.ja).toContain("IAM Role");
    expect(complete?.layout).toBe("complete");
    expect(complete?.heading.ja).toContain("削除完了");
  });

  it("should fit a short cleanup narration budget", () => {
    const totalTargetS = script.cues.reduce((sum, cue) => sum + cue.targetS, 0);
    expect(totalTargetS).toBeGreaterThanOrEqual(35);
    expect(totalTargetS).toBeLessThanOrEqual(50);
  });
});
