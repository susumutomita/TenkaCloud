import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — EventBridge Rules", () => {
  const tpl = synthDefault();

  it("should have 7 EventBridge Rules (Create / Delete / BulkCreate / GenericScoring / ExternalIdAudit schedule / SystemAuditWriter (Issue #1034) / CodeBuildFailure (Issue #1029))", () => {
    // 旧 2 (Create / Delete state-machine event rules)
    //   + BulkCreate (Issue #910 Phase 2.C: BulkDeployCreateRequested → Distributed Map)
    //   + GenericScoring schedule rate(1 minute) (= ADR-012 Phase 3.B、 旧 HealthCheck 後継)
    //   + ExternalIdAudit schedule rate(1 day) (= Phase 3.2 / Issue #603 で追加)
    // = 5。GenericScoring は scoring 問題が無い tenant でも reconcile 用に常時 instantiate される。
    // 旧 5 + Issue #1034 SystemAuditWriter (SBT bus) + Issue #1029 CodeBuildFailure (default bus)
    tpl.resourceCountIs("AWS::Events::Rule", 7);
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
    // GenericScoring の rate(1 minute) schedule (= ADR-012 Phase 3.B dispatcher + reconciler)
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

  it("should have an EventBridge Rule listening to the 6 SBT onboarding/offboarding detailTypes", () => {
    // Issue #1034 SystemAuditWriter: SBT bus 経由で onboarding / offboarding event を audit log に書く。
    tpl.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        EventPattern: Match.objectLike({
          "detail-type": Match.arrayWith([
            "onboardingRequest",
            "onboardingSuccess",
            "onboardingFailure",
            "offboardingRequest",
            "offboardingSuccess",
            "offboardingFailure",
          ]),
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
});
