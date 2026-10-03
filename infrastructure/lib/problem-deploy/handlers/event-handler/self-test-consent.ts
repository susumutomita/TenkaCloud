import type { EventRecord } from "../../control-data/domain/events.js";
import {
  HostingAccountSelfTestRequestSchema,
  isHostingAccountSelfTestAcknowledged,
  UnsupportedHostingAccountError,
} from "../shared/competitor-account-policy.js";
import { isNativeExecutionProblem } from "../shared/execution-catalog-context.js";
import type { SelectedBulkDeployTargets } from "./bulk-deploy/types.js";
import { type EventSharedResources, resolveEventRepositories } from "./shared.js";
import type { BulkDeployRequest, EventItem } from "./types.js";

/** Shared by event creation and deployment of events created before consent existed. */
export function validateSelfTestAcknowledgment(
  shared: EventSharedResources,
  ctx: { readonly nowMs: number; readonly actor?: string },
  req: {
    readonly problems: readonly {
      readonly problemId: string;
      readonly defaultAwsAccountId?: string;
    }[];
    readonly teams: readonly { readonly awsAccountId?: string }[];
    readonly hostingAccountSelfTest?: BulkDeployRequest["hostingAccountSelfTest"];
  },
): EventRecord["hostingAccountSelfTest"] {
  const hostingAccount = process.env.CONTROL_PLANE_ACCOUNT;
  const targetsHostingAccount =
    Boolean(hostingAccount) &&
    req.problems.some((problem) => {
      if (
        !shared.problemsCatalog[problem.problemId] ||
        isNativeExecutionProblem(shared.executionCatalog, problem.problemId)
      )
        return false;
      const runtime = shared.resolveProblemRuntimeDescriptor?.(problem.problemId);
      const usesAws =
        !runtime ||
        ("kind" in runtime
          ? runtime.targets.some((target) => target.provider === "aws")
          : runtime.provider === "aws");
      return (
        usesAws &&
        req.teams.some(
          (team) => (team.awsAccountId ?? problem.defaultAwsAccountId) === hostingAccount,
        )
      );
    });
  if (!targetsHostingAccount && !req.hostingAccountSelfTest) return undefined;
  const parsed = HostingAccountSelfTestRequestSchema.safeParse(req.hostingAccountSelfTest);
  if (
    !targetsHostingAccount ||
    !parsed.success ||
    parsed.data.awsAccountId !== hostingAccount ||
    !ctx.actor ||
    ctx.actor === "unknown"
  ) {
    throw new UnsupportedHostingAccountError(
      hostingAccount ?? req.hostingAccountSelfTest?.awsAccountId ?? "",
    );
  }
  return {
    awsAccountId: parsed.data.awsAccountId,
    riskVersion: parsed.data.riskVersion,
    acknowledgedAt: new Date(ctx.nowMs).toISOString(),
    acknowledgedBy: ctx.actor,
  };
}

export class SelfTestAcknowledgmentConflictError extends Error {
  constructor() {
    super("The event changed while saving self-test consent. Refresh the event before retrying.");
    this.name = "SelfTestAcknowledgmentConflictError";
  }
}

/** Save consent without replacing the existing event, schedule, results, or catalog pin. */
export async function acknowledgeExistingEventSelfTest(args: {
  readonly shared: EventSharedResources;
  readonly tenantId: string;
  readonly eventId: string;
  readonly event: Partial<EventItem>;
  readonly selected: SelectedBulkDeployTargets;
  readonly request: BulkDeployRequest["hostingAccountSelfTest"];
  readonly nowMs: number;
  readonly actor?: string;
}): Promise<Partial<EventItem>> {
  if (!args.request) return args.event;
  if (
    args.event.tenantId !== args.tenantId ||
    args.event.eventId !== args.eventId ||
    args.selected.teams.some(
      (team) => team.tenantId !== args.tenantId || team.eventId !== args.eventId,
    )
  ) {
    throw new SelfTestAcknowledgmentConflictError();
  }
  // The UI may retain consent for an uncertain-response retry, then select a
  // native/foreign-account subset. Existing consent remains valid for this event.
  const request = HostingAccountSelfTestRequestSchema.safeParse(args.request);
  if (
    request.success &&
    request.data.awsAccountId === process.env.CONTROL_PLANE_ACCOUNT &&
    isHostingAccountSelfTestAcknowledged(args.event, request.data.awsAccountId)
  )
    return args.event;
  const acknowledgment = validateSelfTestAcknowledgment(args.shared, args, {
    ...args.selected,
    hostingAccountSelfTest: args.request,
  });
  if (!acknowledgment) throw new SelfTestAcknowledgmentConflictError();
  const { events } = await resolveEventRepositories(args.shared);
  const result = await events.acknowledgeHostingAccountSelfTest(
    args.tenantId,
    args.eventId,
    acknowledgment,
    args.event,
  );
  // A duplicate concurrent request keeps the first actor/time. The returned post-image
  // also carries concurrent schedule/results changes into the deployment plan.
  if (
    result.outcome !== "not_found" &&
    result.event &&
    result.event.catalogKey === args.event.catalogKey &&
    ["DRAFT", "READY", "DEPLOYING"].includes(result.event.status) &&
    isHostingAccountSelfTestAcknowledged(result.event, acknowledgment.awsAccountId)
  )
    return result.event;
  throw new SelfTestAcknowledgmentConflictError();
}
