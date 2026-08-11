/**
 * [Issue #1268] AWS CloudFormation runtime adapter.
 *
 * Wraps the existing AWS-only deploy behavior so callers can resolve a
 * `ProblemRuntimeAdapter` and call `.deploy(...)` without knowing this is the
 * CFn path. This is a behavior-preserving abstraction: the adapter calls the
 * same `publishProblemEvent` with the same shape that pre-#1268 code did, so
 * the downstream Step Functions / CodeBuild pipeline is untouched.
 *
 * `deploy` publishes `DeployCreateRequested` to EventBridge with the legacy event shape.
 * `collectOutputs`, `getStatus`, and `destroy` are not implemented here; existing handlers use
 * direct CloudFormation SDK calls, and these adapter methods fail loudly if invoked.
 */

import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { EXECUTABLE_ENGINE, EXECUTABLE_PROVIDER } from "@tenkacloud/problem-runtime";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  publishProblemEvent,
} from "../events.js";
import {
  optionalParametersField,
  type ProblemRuntimeAdapter,
  type RuntimeCollectOutputsInput,
  type RuntimeDeployInput,
  type RuntimeDeployResult,
  type RuntimeDestroyInput,
  type RuntimeDestroyResult,
  type RuntimeOutputs,
  type RuntimeStatus,
  type RuntimeStatusInput,
} from "./adapter.js";

/**
 * Resources injected by the deploy handler when constructing the adapter.
 * Mirrors the slice of `DeployContext` the existing publish-event path uses.
 */
export interface AwsCloudFormationAdapterContext {
  readonly events: EventBridgeClient;
  readonly eventBusName: string;
}

/**
 * Thrown when an adapter method that exists on the interface but is not
 * implemented by this adapter is called: `collectOutputs`, `getStatus`, or
 * `destroy`. We throw loudly rather than silently no-oping (= AGENTS.md "no
 * silent fallbacks via mocks / stubs / empty-array returns").
 */
export class AdapterMethodNotWiredError extends Error {
  constructor(method: string) {
    super(
      `AwsCloudFormationRuntimeAdapter.${method} is not implemented. ` +
        `Existing handlers use direct CloudFormation SDK calls; refusing to return a placeholder result.`,
    );
    this.name = "AdapterMethodNotWiredError";
  }
}

export class AwsCloudFormationRuntimeAdapter implements ProblemRuntimeAdapter {
  public readonly provider = EXECUTABLE_PROVIDER;
  public readonly engine = EXECUTABLE_ENGINE;

  constructor(private readonly ctx: AwsCloudFormationAdapterContext) {}

  async deploy(input: RuntimeDeployInput): Promise<RuntimeDeployResult> {
    // Build the legacy detail shape unchanged. Behavior preservation requires
    // that downstream consumers (`DeployCreateStateMachine`, CodeBuild scripts)
    // see exactly the same field set as before the adapter existed.
    const detail: DeployCreateRequestedDetail = {
      jobId: input.jobId,
      correlationId: input.correlationId,
      tenantId: input.tenantId,
      problemId: input.problemId,
      problemDir: input.problemDir,
      teamSlug: input.teamSlug,
      namePrefix: input.namePrefix,
      region: input.region,
      awsAccountId: input.awsAccountId,
      ...(input.competitorRoleArn ? { competitorRoleArn: input.competitorRoleArn } : {}),
      ...(input.externalIdParameterName
        ? { externalIdParameterName: input.externalIdParameterName }
        : {}),
      ...(input.challengePayloadUrl ? { challengePayloadUrl: input.challengePayloadUrl } : {}),
      // [Composite Runtime / #2747] Bound Composite input values, forwarded verbatim so
      // create-stack.ts (deployViaLambda) can merge them into the CFn Parameters it builds.
      ...optionalParametersField(input.parameters),
    };
    await publishProblemEvent({
      client: this.ctx.events,
      busName: this.ctx.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
      jobId: input.jobId,
      detail,
    });
    return { status: "pending" };
  }

  async collectOutputs(_input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs> {
    throw new AdapterMethodNotWiredError("collectOutputs");
  }

  async getStatus(_input: RuntimeStatusInput): Promise<RuntimeStatus> {
    throw new AdapterMethodNotWiredError("getStatus");
  }

  async destroy(_input: RuntimeDestroyInput): Promise<RuntimeDestroyResult> {
    throw new AdapterMethodNotWiredError("destroy");
  }
}
