import { describe, expect, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — Step Functions State Machines", () => {
  const tpl = synthDefault();

  it("should create 3 State Machines (Create / Delete / BulkCreate) (Issue #910 Phase 2.C.2.a)", () => {
    tpl.resourceCountIs("AWS::StepFunctions::StateMachine", 3);
  });

  it("Create State Machine should write the PENDING → IN_PROGRESS intermediate transition before starting CodeBuild", () => {
    // RUN_JOB 同期 CodeBuild は 5〜15 分かかるため、この中間書込が無いと operator UI が
    // PENDING のまま固定して polling が機能していないように見える (#159 の再発防止)。
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const synthJson = JSON.stringify(stateMachines);
    expect(synthJson).toContain("MarkInProgress");
    expect(synthJson).toContain("IN_PROGRESS");
  });

  it("Create State Machine should persist the CodeBuild buildId into the Deployments row on completion/failure", () => {
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const createStateMachine = Object.values(stateMachines)
      .map((stateMachine) => JSON.stringify(stateMachine))
      .find((definition) => definition.includes("StartDeployCodeBuild"));

    expect(createStateMachine).toBeDefined();
    expect(createStateMachine).toContain("MarkSucceeded");
    expect(createStateMachine).toContain("MarkFailed");
    expect(createStateMachine).toContain("PROBLEM_EXTERNAL_ID");
    expect(createStateMachine).toContain("$.detail.jobId");
    expect(createStateMachine).toContain(
      "stackId = :stackId, stackOutputs = :stackOutputs, buildId = :buildId",
    );
    expect(createStateMachine).toContain("#failureReason = :failureReason, buildId = :buildId");
    expect(createStateMachine).toContain("$.codebuild.Build.Id");
  });

  it("Create State Machine should Catch CodeBuild timeout / AccessDenied and fall to FAILED", () => {
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const createStateMachine = Object.values(stateMachines)
      .map((stateMachine) => JSON.stringify(stateMachine))
      .find((definition) => definition.includes("StartDeployCodeBuild"));

    expect(createStateMachine).toBeDefined();
    expect(createStateMachine).toContain("StartDeployCodeBuild");
    expect(createStateMachine).toContain("StartDeployCodeBuildCrossAccount");
    expect(createStateMachine).toContain("States.ALL");
    expect(createStateMachine).toContain("RouteFailedDeployment");
    expect(createStateMachine).toContain("MarkFailed");
    expect(createStateMachine).toContain("MarkFailedWithoutBuildId");
  });

  it("Create State Machine should treat ROLLBACK_COMPLETE as terminal failure and fall to MarkFailed", () => {
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const createStateMachine = Object.values(stateMachines)
      .map((stateMachine) => JSON.stringify(stateMachine))
      .find((definition) => definition.includes("StartDeployCodeBuild"));

    expect(createStateMachine).toBeDefined();
    expect(createStateMachine).toContain("RouteDescribedStackStatus");
    expect(createStateMachine).toContain("UseStackStatusReasonAsFailureCause");
    expect(createStateMachine).toContain("$.cfn.Stacks[0].StackStatus");
    expect(createStateMachine).toContain("ROLLBACK_COMPLETE");
    expect(createStateMachine).toContain("CREATE_FAILED");
    expect(createStateMachine).toContain("UPDATE_ROLLBACK_COMPLETE");
    expect(createStateMachine).toContain("$.cfn.Stacks[0].StackStatusReason");
    expect(createStateMachine).toContain("MarkFailed");
  });

  it("Create State Machine should run DescribeStacks via Lambda (#762)", () => {
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const createStateMachine = Object.values(stateMachines)
      .map((stateMachine) => JSON.stringify(stateMachine))
      .find((definition) => definition.includes("StartDeployCodeBuild"));

    expect(createStateMachine).toBeDefined();
    expect(createStateMachine).toContain("RouteCreateInput");
    expect(createStateMachine).toContain("StartDeployCodeBuildCrossAccount");
    expect(createStateMachine).toContain("DescribeStack");
    expect(createStateMachine).toContain("DescribeStackFunction");
    expect(createStateMachine).not.toContain(
      "arn:aws:states:::aws-sdk:cloudformation:describeStacks",
    );
    expect(createStateMachine).not.toContain("States.Format('{}', $.detail.competitorRoleArn)");
  });

  it("Delete State Machine should Choice on the presence of AssumeRole metadata and not die at runtime on missing path references (#758)", () => {
    const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
    const deleteStateMachine = Object.values(stateMachines)
      .map((stateMachine) => JSON.stringify(stateMachine))
      .find((definition) => definition.includes("StartDeleteCodeBuild"));

    expect(deleteStateMachine).toBeDefined();
    expect(deleteStateMachine).toContain("RouteDeleteInput");
    expect(deleteStateMachine).toContain("StartDeleteCodeBuildCrossAccount");
    expect(deleteStateMachine).toContain("InvalidAssumeRoleMetadata");
    expect(deleteStateMachine).toContain("$.detail.competitorRoleArn");
    expect(deleteStateMachine).toContain("$.detail.externalIdParameterName");
    expect(deleteStateMachine).toContain("MarkFailed");
  });
});
