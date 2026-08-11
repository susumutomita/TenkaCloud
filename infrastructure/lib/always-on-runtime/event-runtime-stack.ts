import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { EventRuntimeArchive, type EventRuntimeArchiveProps } from "./event-runtime-archive.js";
import { EventRuntimeScoring, type EventRuntimeScoringProps } from "./event-runtime-scoring.js";
import { applyAlwaysOnRuntimeTags, MANAGED_BY_ALWAYS_ON_RUNTIME } from "./runtime-tags.js";

/** Prefix shared by every per-event runtime stack targeted by the lifecycle workflows. */
export const EVENT_RUNTIME_STACK_ID_PREFIX = "tenkacloud-event-runtime";

/**
 * eventId must start alphanumeric and contain only `[A-Za-z0-9-]` so
 * `tenkacloud-event-runtime-<eventId>` satisfies the CloudFormation stack-name regex
 * `/^[A-Za-z][A-Za-z0-9-]*$/` (note: underscores, dots, spaces are NOT stack-name safe even
 * though SSM would accept them). Real event ids are ULIDs (Crockford base32), which qualify;
 * a malformed dispatch input is rejected here with a clear error instead of a cryptic synth
 * failure much later.
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Build the logical stack id used to deploy or destroy one event runtime. */
export function buildEventRuntimeStackId(eventId: string): string {
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new Error(
      `eventId must be alphanumeric with optional hyphens (CloudFormation stack-name safe); got ${JSON.stringify(
        eventId,
      )}.`,
    );
  }
  return `${EVENT_RUNTIME_STACK_ID_PREFIX}-${eventId}`;
}

/** Build the SSM parameter name that records one live event runtime. */
export function buildEventRuntimeManifestParameterName(eventId: string): string {
  return `/tenkacloud/always-on/event-runtime/${eventId}`;
}

export interface EventRuntimeStackProps extends cdk.StackProps {
  readonly eventId: string;
  readonly tenantId: string;
  readonly expiresAt: string;
  readonly scoring?: Omit<EventRuntimeScoringProps, "eventId">;
  readonly archive?: Omit<EventRuntimeArchiveProps, "eventId">;
}

/**
 * per-event runtime lifecycle stack.
 *
 * The manifest anchors the runtime's per-event identity and cleanup tags. Optional scoring and
 * archive resources share that identity without changing the lifecycle contract.
 */
export class EventRuntimeStack extends cdk.Stack {
  public readonly manifestParameterName: string;
  public readonly manifestParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: EventRuntimeStackProps) {
    super(scope, id, props);

    if (props.eventId.trim() === "") {
      throw new Error("EventRuntimeStack eventId must be non-empty.");
    }
    if (props.tenantId.trim() === "") {
      throw new Error("EventRuntimeStack tenantId must be non-empty.");
    }

    this.manifestParameterName = buildEventRuntimeManifestParameterName(props.eventId);
    this.manifestParameter = new ssm.StringParameter(this, "Manifest", {
      parameterName: this.manifestParameterName,
      stringValue: JSON.stringify({
        eventId: props.eventId,
        tenantId: props.tenantId,
        expiresAt: props.expiresAt,
        managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME,
      }),
      description: "TenkaCloud Always-On event runtime manifest.",
    });

    if (props.scoring) {
      new EventRuntimeScoring(this, "Scoring", {
        ...props.scoring,
        eventId: props.eventId,
      });
    }
    if (props.archive) {
      const archive = new EventRuntimeArchive(this, "Archive", {
        ...props.archive,
        eventId: props.eventId,
      });
      new cdk.CfnOutput(this, "ArchiveFunctionName", {
        value: archive.fn.functionName,
        description: "Invoke before destroy to export raw score events.",
      });
    }

    applyAlwaysOnRuntimeTags(this, {
      eventId: props.eventId,
      tenantId: props.tenantId,
      expiresAt: props.expiresAt,
    });
  }
}
