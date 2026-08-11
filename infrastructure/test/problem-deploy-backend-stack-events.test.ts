import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { SBT_ONBOARDING_DETAIL_TYPES } from "../lib/problem-deploy/handlers/system-audit-writer/sbt-detail-types";
import {
  synthWithCodeBuild,
  synthWithDeployViaLambda,
} from "./problem-deploy-backend-stack.test-helpers";

// Issue #2291: Lambda 既定では DeployFailureRule が加わり Rule 数が 9 になるため、在来 8 Rule と
// CodeBuild 失敗 Rule を検証するこの suite は CodeBuild 経路 (flag=false rollback 相当) を明示 synth する。
describe("ProblemDeployBackendStack (MVP-1) — EventBridge Rules", () => {
  const tpl = synthWithCodeBuild();

  it("should have 8 EventBridge Rules (Create / Delete / BulkCreate / GenericScoring / ExternalIdAudit schedule / SystemAuditWriter (Issue #1034) / CodeBuildFailure (Issue #1029) / DisruptionExecutor (#1419))", () => {
    // 旧 2 (Create / Delete state-machine event rules)
    //   + BulkCreate (Issue #910 Phase 2.C: BulkDeployCreateRequested → Distributed Map)
    //   + GenericScoring schedule rate(1 minute), replacing the legacy HealthCheck rule
    //   + ExternalIdAudit schedule rate(1 day) (= Phase 3.2 / Issue #603 で追加)
    // = 5。GenericScoring は scoring 問題が無い tenant でも reconcile 用に常時 instantiate される。
    // 旧 5 + Issue #1034 SystemAuditWriter (SBT bus) + Issue #1029 CodeBuildFailure (default bus)
    // + #1419 DisruptionExecutor (tenkacloud.disruptions → cross-account fault executor)
    tpl.resourceCountIs("AWS::Events::Rule", 8);
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ["tenkacloud.deploy"],
          "detail-type": ["DeployCreateRequested"],
        }),
      }),
    );
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ["tenkacloud.deploy"],
          "detail-type": ["DeployDeleteRequested"],
        }),
      }),
    );
    // GenericScoring の rate(1 minute) schedule (= dispatcher + reconciler)
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        ScheduleExpression: "rate(1 minute)",
      }),
    );
    // ExternalIdAudit の rate(1 day) schedule (Phase 3.2 / Issue #603)
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        ScheduleExpression: "rate(1 day)",
      }),
    );
  });

  it("should have an EventBridge Rule listening to exactly the shared SBT onboarding/offboarding detailTypes", () => {
    // Issue #1034 SystemAuditWriter: SBT bus 経由で onboarding / offboarding event を audit log に書く。
    // Issue #2201: フィルタは sbt-detail-types.ts の共有定数と**完全一致** (= 部分一致でなく) で
    // 固定する。 handler 側の対応表は Record<SbtOnboardingDetailType, ...> で同じ定数に型固定
    // されているため、 Rule と対応表のキー集合が同一であることが機械保証される。
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          "detail-type": [...SBT_ONBOARDING_DETAIL_TYPES],
        }),
      }),
    );
  });

  it("Issue #1029: should have a Rule catching CodeBuild FAILED / FAULT / STOPPED / TIMED_OUT events", () => {
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ["aws.codebuild"],
          "detail-type": ["CodeBuild Build State Change"],
          detail: Match.objectLike({
            "build-status": Match.arrayWith(["FAILED", "FAULT", "STOPPED", "TIMED_OUT"]),
          }),
        }),
      }),
    );
  });

  it("Issue #2291: should NOT add the deploy-failure rule when deployViaLambda is off (rollback-safe)", () => {
    // flag OFF (= synthWithCodeBuild) では `TenkaCloud Deploy Failed` を listen する Rule は無い。
    const rules = tpl.findResources("AWS::Events::Rule");
    const hasDeployFailedRule = Object.values(rules).some((r) => {
      const detailType = r.Properties?.EventPattern?.["detail-type"];
      return Array.isArray(detailType) && detailType.includes("TenkaCloud Deploy Failed");
    });
    if (hasDeployFailedRule) {
      throw new Error("deploy-failure rule must not exist when deployViaLambda is off");
    }
  });
});

describe("ProblemDeployBackendStack — deployViaLambda EventBridge Rules (Issue #2291)", () => {
  const tpl = synthWithDeployViaLambda();

  it("should add a deploy-failure rule listening to TenkaCloud Deploy Failed when deployViaLambda is true", () => {
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ["tenkacloud.problem-deploy"],
          "detail-type": ["TenkaCloud Deploy Failed"],
        }),
      }),
    );
  });

  it("should have 9 EventBridge Rules (default 8 + DeployFailureRule)", () => {
    // 在来 8 (Create / Delete / BulkCreate / GenericScoring / ExternalIdAudit / SystemAuditWriter /
    // CodeBuildFailure / DisruptionExecutor) + Issue #2291 DeployFailureRule = 9。
    tpl.resourceCountIs("AWS::Events::Rule", 9);
  });
});
