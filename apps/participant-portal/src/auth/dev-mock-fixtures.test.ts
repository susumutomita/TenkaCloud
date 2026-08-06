import {
  LITE_CLEANUP_DRILL_CHECKPOINT,
  LITE_CLEANUP_DRILL_PROBLEM_ID,
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
  CUSTOM_CHALLENGE_PROBLEM_ID,
  CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
  evaluateMockSubFlag,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "../dev-mock/flag-submit";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";
import { LOCAL_ONBOARDING_COMMANDS } from "./local-onboarding-contract";

/**
 * Issue #2696 / #2707 / #2711: LP デモの固定出題 (オンボーディングドリル + 2 クエスト) の
 * 整合性を pin する。 ドリルの sub-flag id が判定側 (`evaluateMockSubFlag`) と揃って
 * いなければ永遠に wrong を返すし、 ヒントの無いドリルは「本文は概要 → ヒントで
 * ステップバイステップ」 という構造契約を破る。問題 1 は動画の real cloud、
 * Battle / Challenge、Local / Lite / SaaS を省略せず、実際の「問題文を読む →
 * 問題環境を起動 → 調査・修正 → flag を提出して採点」へつなぐ。6 問すべてが
 * 標準の multi-flag 入力・ヒント公開・採点を使う。
 */
describe("dev-mock fixtures", () => {
  const ONBOARDING_DRILL_IDS = [
    WHAT_IS_DRILL_PROBLEM_ID,
    LITE_DRILL_PROBLEM_ID,
    LITE_CLEANUP_DRILL_PROBLEM_ID,
    LOCAL_DRILL_PROBLEM_ID,
    AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
    CUSTOM_CHALLENGE_PROBLEM_ID,
  ];
  const drills = DEV_MOCK_TEAM_VIEW.problems.filter((p) =>
    ONBOARDING_DRILL_IDS.includes(p.problemId),
  );

  it("should pin the onboarding drills first, in journey order (#2711, #2781)", () => {
    expect(
      DEV_MOCK_TEAM_VIEW.problems.slice(0, ONBOARDING_DRILL_IDS.length).map((p) => p.problemId),
    ).toEqual(ONBOARDING_DRILL_IDS);
  });

  it("should connect every video topic to the real solve-and-score journey", () => {
    const tutorial = drills.find((p) => p.problemId === WHAT_IS_DRILL_PROBLEM_ID);
    expect(tutorial?.scoring?.flags?.map((f) => f.id)).toEqual([
      "tenka-what",
      "battle-challenge",
      "choose-mode",
      "read-problem",
      "open-endpoint",
      "first-flag",
    ]);
    const body = tutorial?.description ?? "";
    expect(body).toContain("クラウド");
    expect(body).toContain("Docker");
    expect(body).toContain("Battle");
    expect(body).toContain("Challenge");
    expect(body).toContain("Local");
    expect(body).toContain("Lite");
    expect(body).toContain("SaaS");
    expect(body).toContain("問題文");
    expect(body).toContain("問題環境");
    expect(body).toContain("flag");
    expect(body).toContain("提出して得点");
    expect(body).toContain("ヒントを公開する");
    expect(body).not.toContain("WordPress");
    expect(body).not.toContain("CloudFormation");
    expect(tutorial?.i18n?.en?.description).toContain(
      "same endpoint display, flag input, hint reveal",
    );
    for (const [flagId, answer] of [
      ["tenka-what", "real cloud"],
      ["battle-challenge", "battle"],
      ["choose-mode", "local"],
      ["read-problem", "problem statement"],
      ["open-endpoint", "CONNECTED"],
      ["first-flag", "TC{HELLO-TENKACLOUD}"],
    ] as const) {
      expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, flagId, answer, 100).kind).toBe("ok");
    }
  });

  it("should make the final flag discoverable from the practice endpoint without revealing it in the hint", () => {
    const tutorial = drills.find((p) => p.problemId === WHAT_IS_DRILL_PROBLEM_ID);
    const firstFlag = tutorial?.scoring?.flags?.find((flag) => flag.id === "first-flag");
    const hint = firstFlag?.hints?.[0];

    expect(hint?.content).toContain("接続先");
    expect(hint?.content).not.toContain("TC{HELLO-TENKACLOUD}");
    expect(hint?.i18n?.en?.content).toContain("endpoint");
    expect(hint?.i18n?.en?.content).not.toContain("TC{HELLO-TENKACLOUD}");
  });

  it("should ship every onboarding problem as an unsolved multi-flag drill", () => {
    expect(drills).toHaveLength(6);
    for (const drill of drills) {
      expect(drill.scoring?.kind).toBe("multi-flag");
      expect(drill.score).toBe(0);
      expect(drill.scoring?.flags?.length).toBeGreaterThan(0);
      expect(drill.scoring?.flags?.every((f) => !f.solved)).toBe(true);
    }
  });

  it("should give every drill sub-flag a penalty-free step-by-step hint with content", () => {
    for (const drill of drills) {
      for (const flag of drill.scoring?.flags ?? []) {
        expect(flag.hints, `${drill.problemId}/${flag.id} has no hints`).toBeDefined();
        for (const hint of flag.hints ?? []) {
          expect(hint.penalty).toBe(0);
          expect(hint.revealed).toBe(false);
          // dev-mock は reveal をローカル state で行うため content を同梱する。
          expect(hint.content).toBeTruthy();
          // #2711 follow-up: en locale でヒントが日本語のまま出る bug の再発防止 — 全ヒントに英訳を同梱。
          expect(
            hint.i18n?.en?.content,
            `${drill.problemId}/${flag.id}/${hint.id} has no en hint`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("should tell the local drill player the team key is auto-filled at login (no manual key entry)", () => {
    const local = drills.find((p) => p.problemId === LOCAL_DRILL_PROBLEM_ID);
    // Opening the Portal lands on a login screen; make local pre-fills the throwaway
    // team key into runtime-config, so the step must say "just sign in", not "type a key".
    expect(local?.description).toContain("チームキーは自動で入力済み");
    expect(local?.description).toContain("「サインイン」を押すだけ");
    expect(local?.i18n?.en?.description).toContain("team key is already filled in");
    expect(local?.i18n?.en?.description).toContain("just press **Sign in**");
  });

  it("should keep the lite drill sub-flag ids aligned with the lite-drill contract, in journey order", () => {
    const lite = drills.find((p) => p.problemId === LITE_DRILL_PROBLEM_ID);
    expect(lite?.scoring?.flags?.map((f) => f.id)).toEqual([
      LITE_DRILL_CHECKPOINTS.launcherCreated.flagId,
      LITE_DRILL_CHECKPOINTS.deployComplete.flagId,
      LITE_DRILL_CHECKPOINTS.competitorVerified.flagId,
      LITE_DRILL_CHECKPOINTS.firstEventCreated.flagId,
    ]);
  });

  it("should link the exact Lite template and CloudFormation create-stack entry", () => {
    const lite = drills.find((p) => p.problemId === LITE_DRILL_PROBLEM_ID);
    const launcherHint = lite?.scoring?.flags?.find(
      (flag) => flag.id === LITE_DRILL_CHECKPOINTS.launcherCreated.flagId,
    )?.hints?.[0];

    expect(launcherHint?.content).toContain(
      "github.com/susumutomita/TenkaCloud/blob/main/infrastructure/templates/lite-pipeline.yaml",
    );
    expect(launcherHint?.content).toContain(
      "console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template",
    );
    expect(launcherHint?.i18n?.en?.content).toContain(
      "github.com/susumutomita/TenkaCloud/blob/main/infrastructure/templates/lite-pipeline.yaml",
    );
    expect(launcherHint?.i18n?.en?.content).toContain(
      "console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template",
    );
    expect(lite?.description).not.toContain("デプロイ用パイプライン");
    expect(lite?.description).toContain("CloudFormationに読み込ませる");
    expect(lite?.description).toContain("CodeBuildとIAM Role");
    expect(lite?.description).toContain("AWS CodePipelineは使わない");
    expect(lite?.description).toContain("AWS経験者向け");
    expect(lite?.description).toContain(
      "CloudFormation stack → CodeBuild project → CDK deploy → CloudFormation stacks",
    );
    expect(lite?.description).toContain("細かいデプロイ手順");
    expect(lite?.description).toContain("Start build");
    expect(lite?.i18n?.en?.description).not.toContain("deployment pipeline");
    expect(lite?.i18n?.en?.description).toContain("load into CloudFormation");
    expect(lite?.i18n?.en?.description).toContain("CodeBuild project and IAM Role");
    expect(lite?.i18n?.en?.description).toContain("does not use the AWS CodePipeline service");
    expect(lite?.i18n?.en?.description).toContain("AWS shorthand");
    expect(lite?.i18n?.en?.description).toContain("without learning");
    expect(lite?.i18n?.en?.description).toContain("Start build");
    expect(lite?.description).toContain("#### AWSサービスの役割");
    expect(lite?.i18n?.en?.description).toContain("#### What the AWS services do");
    for (const service of [
      "CloudFormation",
      "CodeBuild",
      "IAM Role",
      "S3",
      "CloudFront",
      "Cognito",
      "Lambda",
      "API Gateway",
      "DynamoDB",
      "Step Functions",
      "EventBridge",
      "CloudWatch",
      "Systems Manager",
    ]) {
      expect(lite?.description).toContain(service);
      expect(lite?.i18n?.en?.description).toContain(service);
    }

    expect(launcherHint?.content).not.toContain("デプロイ用パイプライン");
    expect(launcherHint?.content).toContain("自動デプロイ環境");
    expect(launcherHint?.content).toContain("tenkacloud-lite-launcher");
    expect(launcherHint?.content).toContain("手動で操作する必要はない");
    expect(launcherHint?.content).toContain("tenkacloud-lite-problem-deploy");
    expect(launcherHint?.i18n?.en?.content).not.toContain("deployment pipeline");
    expect(launcherHint?.i18n?.en?.content).toContain("automatic deployment setup");
    expect(launcherHint?.i18n?.en?.content).toContain("tenkacloud-lite-launcher");
    expect(launcherHint?.i18n?.en?.content).toContain("do not operate");
    expect(launcherHint?.i18n?.en?.content).toContain("tenkacloud-lite-problem-deploy");
  });

  it("should keep cleanup out of the deploy drill and give it a separate scored problem", () => {
    const deploy = drills.find((p) => p.problemId === LITE_DRILL_PROBLEM_ID);
    const cleanup = drills.find((p) => p.problemId === LITE_CLEANUP_DRILL_PROBLEM_ID);

    expect(deploy?.videoUrl).toBe("https://www.youtube.com/embed/ItgRfIeQ0ac");
    expect(deploy?.i18n?.en?.videoUrl).toBe("https://www.youtube.com/embed/7LjkPdf5zM0");
    expect(deploy?.description).not.toContain("ACTION=destroy");
    expect(deploy?.i18n?.en?.description).not.toContain("ACTION=destroy");
    expect(cleanup?.videoUrl).toBe("https://www.youtube.com/embed/sRUn3Tzu4UM");
    expect(cleanup?.i18n?.en?.videoUrl).toBe("https://www.youtube.com/embed/BOrIywCb_KU");
    expect(cleanup?.scoring?.flags?.map((f) => f.id)).toEqual([
      LITE_CLEANUP_DRILL_CHECKPOINT.flagId,
    ]);
    expect(cleanup?.description).toContain("ACTION=destroy-all");
    expect(cleanup?.description).toContain("launcher");
    expect(cleanup?.description).toContain("自分で確認");
    expect(cleanup?.i18n?.en?.description).toContain("ACTION=destroy-all");
    expect(cleanup?.i18n?.en?.description).toContain("launcher");
    expect(cleanup?.i18n?.en?.description).toContain("self-confirm");
  });

  it("should make every drill sub-flag strict: the generic mock flag never solves it", () => {
    for (const drill of drills) {
      for (const flag of drill.scoring?.flags ?? []) {
        const outcome = evaluateMockSubFlag(drill.problemId, flag.id, "tenkacloudsample", 10);
        expect(outcome.kind, `${drill.problemId}/${flag.id} accepted the generic flag`).toBe(
          "wrong",
        );
      }
    }
  });

  it("should ship the drill narratives in both Japanese and English", () => {
    for (const drill of drills) {
      expect(drill.name).toBeTruthy();
      expect(drill.description).toBeTruthy();
      expect(drill.instructions).toBeTruthy();
      expect(drill.i18n?.en?.name).toBeTruthy();
      expect(drill.i18n?.en?.description).toBeTruthy();
      expect(drill.i18n?.en?.instructions).toBeTruthy();
      for (const flag of drill.scoring?.flags ?? []) {
        expect(flag.i18n?.en?.label).toBeTruthy();
      }
    }
  });

  it("should localize the AI-agent Mac tutorial video for English", () => {
    const drill = DEV_MOCK_TEAM_VIEW.problems.find(
      (problem) => problem.problemId === "ai-agent-local-mac",
    );
    expect(drill?.videoUrl).toBe("https://www.youtube.com/embed/nLsSJ3npdfw");
    expect(drill?.i18n?.en?.videoUrl).toBe("https://www.youtube.com/embed/GDu9FhWrQns");
  });

  it("should localize the What is TenkaCloud tutorial video for English", () => {
    const drill = DEV_MOCK_TEAM_VIEW.problems.find(
      (problem) => problem.problemId === WHAT_IS_DRILL_PROBLEM_ID,
    );
    expect(drill?.videoUrl).toBe("https://www.youtube.com/embed/mcL_O17QVsA");
    expect(drill?.i18n?.en?.videoUrl).toBe("https://www.youtube.com/embed/6qMzFcP5dgw");
  });

  // #2814: 非エンジニアにも Docker / container / terminal を目的から説明し、
  // 実在する WordPress 問題へ迷わず進めることを pin する。
  it("should explain the required terms and route to the real WordPress problem", () => {
    const drill = drills.find((problem) => problem.problemId === LOCAL_DRILL_PROBLEM_ID);
    for (const body of [drill?.description, drill?.i18n?.en?.description]) {
      expect(body).toContain("`make local`");
      expect(body).not.toContain("make install");
      expect(body).not.toContain("bun link");
      expect(body).not.toContain("bun run");
      expect(body).toContain("Codespaces");
      expect(body).toContain("Docker");
      expect(body).toContain("5175");
      expect(body).toContain("$7");
      expect(body).toContain("WSL2");
      expect(body).toContain("wp-exposed-backup");
      expect(body).toContain("WordPress");
      expect(body).toMatch(/コンテナ|Container/);
      expect(body).toMatch(/ターミナル|Terminal/);
      const commands = body
        ?.split("\n")
        .map((line) => line.match(/^\d+\. `([^`]+)`$/)?.[1])
        .filter((command): command is string => command !== undefined);
      expect(commands?.slice(0, LOCAL_ONBOARDING_COMMANDS.length)).toEqual(
        LOCAL_ONBOARDING_COMMANDS,
      );
      expect(body).toMatch(/automatically|自動/);
      expect(body).toMatch(/fallback|失敗/);
    }
    expect(drill?.description).not.toContain("手元の Mac");
    expect(drill?.i18n?.en?.description).not.toContain("your Mac");
    // ラベル / ヒントにも Mac 前提を残さない (macOS 表記は description 側のみ)。
    for (const flag of drill?.scoring?.flags ?? []) {
      const texts = [
        flag.label,
        flag.i18n?.en?.label,
        ...(flag.hints ?? []).flatMap((h) => [h.content, h.i18n?.en?.content]),
      ];
      for (const text of texts) {
        expect(text, `local drill flag ${flag.id} still assumes a Mac`).not.toContain("Mac");
      }
    }
  });

  it("should keep stale local-mode footage off the portal and use YouTube for current videos", () => {
    const publishedVideos = new Map<string, { readonly ja: string; readonly en: string }>([
      [
        WHAT_IS_DRILL_PROBLEM_ID,
        {
          ja: "https://www.youtube.com/embed/mcL_O17QVsA",
          en: "https://www.youtube.com/embed/6qMzFcP5dgw",
        },
      ],
      [
        AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
        {
          ja: "https://www.youtube.com/embed/nLsSJ3npdfw",
          en: "https://www.youtube.com/embed/GDu9FhWrQns",
        },
      ],
      [
        LITE_DRILL_PROBLEM_ID,
        {
          ja: "https://www.youtube.com/embed/ItgRfIeQ0ac",
          en: "https://www.youtube.com/embed/7LjkPdf5zM0",
        },
      ],
      [
        LITE_CLEANUP_DRILL_PROBLEM_ID,
        {
          ja: "https://www.youtube.com/embed/sRUn3Tzu4UM",
          en: "https://www.youtube.com/embed/BOrIywCb_KU",
        },
      ],
    ]);

    for (const drill of drills) {
      // 公開済みチュートリアルはリポジトリ肥大化を避けるため YouTube へ分離する。
      const published = publishedVideos.get(drill.problemId);
      if (published) {
        expect(drill.videoUrl).toBe(published.ja);
        expect(drill.i18n?.en?.videoUrl).toBe(published.en);
        continue;
      }
      // 正しいYouTube版ができるまでは、リポジトリへ動画を置かず非表示にする。
      // add-custom-challenge は手を動かす作業ドリルで、収録予定の動画も無い。
      expect([LOCAL_DRILL_PROBLEM_ID, CUSTOM_CHALLENGE_PROBLEM_ID]).toContain(drill.problemId);
      expect(drill.videoUrl).toBeUndefined();
      expect(drill.i18n?.en?.videoUrl).toBeUndefined();
    }
  });

  it("should keep the leaderboard problem totals in sync with the fixture problem count", () => {
    const total = DEV_MOCK_TEAM_VIEW.problems.length;
    for (const entry of DEV_MOCK_LEADERBOARD.entries) {
      expect(entry.totalProblems).toBe(total);
    }
  });

  it("should announce the onboarding drills in the notifications feed", () => {
    const bodies = DEV_MOCK_NOTIFICATIONS.items.map((n) => `${n.title} ${n.body}`).join("\n");
    expect(bodies).toContain("TenkaCloud とは?");
    expect(bodies).toContain("ローカルモードで遊ぶ");
    expect(bodies).toContain("自分の TenkaCloud Lite を立てる");
    expect(bodies).toContain("TenkaCloud Lite を片付ける");
    expect(bodies).toContain("AIエージェントでMac起動");
    expect(bodies).toContain("独自問題を追加する");
  });

  // Issue #2781: 最終問題は「解く」ではなく「作る」。 既存問題の置換ではなく 2 問目の
  // 追加を要求し、 雛形のままの id では checkpoint が通らないことを契約として pin する。
  it("should end the journey with an authoring drill that adds a second problem", () => {
    const drill = drills.find((problem) => problem.problemId === CUSTOM_CHALLENGE_PROBLEM_ID);
    expect(drill?.scoring?.flags?.map((flag) => flag.id)).toEqual([
      CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
      CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
    ]);
    for (const body of [drill?.description, drill?.i18n?.en?.description]) {
      expect(body).toContain("hello-world");
    }
    // 雛形を消して 1 問にするのではなく足すので、 validator が通す数は 2。
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
        "2",
        100,
      ).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
        "TC{CUSTOM-CHALLENGE:hello-world}",
        100,
      ).kind,
    ).toBe("wrong");
  });
});
