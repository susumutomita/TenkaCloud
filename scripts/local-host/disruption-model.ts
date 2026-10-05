import type { DisruptionDispatch, DisruptionFireRequest } from "@tenkacloud/problem-sdk/internal";
import { z } from "zod";

const dispatchSchema = z.object({
  kind: z.enum(["ssm-run-command", "lambda-invoke", "cfn-stack-update"]),
  target: z.string(),
  documentName: z.string().optional(),
  params: z.record(z.string(), z.unknown()),
});
export const disruptionTargetSchema = z.object({
  jobId: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  stackId: z.string(),
  unitHash: z.string(),
  deployedAt: z.number(),
  accountId: z.string(),
  region: z.string(),
  roleArn: z.string(),
  resources: z.array(z.string()),
  inject: dispatchSchema,
  revert: dispatchSchema,
  afterSeconds: z.number(),
});
export type DisruptionTarget = z.infer<typeof disruptionTargetSchema>;

export type Submission =
  | { kind: "accepted"; operationId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; reason: string };
export type Observation =
  | { kind: "pending" }
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "unknown"; reason: string };

export interface DisruptionAdapter {
  submit(args: {
    target: DisruptionTarget;
    dispatch: DisruptionDispatch;
    operationKey: string;
    assertCurrent: () => void;
  }): Promise<Submission>;
  observe(args: { target: DisruptionTarget; operationId: string }): Promise<Observation>;
  discover(args: {
    target: DisruptionTarget;
    dispatch: DisruptionDispatch;
    operationKey: string;
    sentAt: number;
  }): Promise<{ kind: "found"; operationId: string } | { kind: "unknown"; reason: string }>;
}

const operationSchema = z.object({
  key: z.string(),
  sentAt: z.number(),
  operationId: z.string().optional(),
});
const executionBase = z.object({
  id: z.string(),
  eventId: z.string(),
  requestId: z.string(),
  tick: z.number(),
  teamId: z.string(),
  dueAt: z.number(),
  target: disruptionTargetSchema,
  updatedAt: z.number(),
});
export const disruptionExecutionSchema = executionBase.and(
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("queued") }),
    z.object({ status: z.literal("skipped"), reason: z.string() }),
    z.object({ status: z.literal("failed"), reason: z.string() }),
    z.object({ status: z.literal("injecting"), inject: operationSchema, revertAt: z.number() }),
    z.object({
      status: z.literal("inject_pending"),
      inject: operationSchema,
      revertAt: z.number(),
    }),
    z.object({
      status: z.literal("inject_unknown"),
      inject: operationSchema,
      revertAt: z.number(),
      reason: z.string(),
    }),
    z.object({
      status: z.literal("revert_due"),
      inject: operationSchema,
      revertAt: z.number(),
      injectOutcome: z.enum(["completed", "failed"]),
    }),
    z.object({
      status: z.literal("reverting"),
      inject: operationSchema,
      revert: operationSchema,
      revertAt: z.number(),
    }),
    z.object({
      status: z.literal("revert_pending"),
      inject: operationSchema,
      revert: operationSchema,
      revertAt: z.number(),
    }),
    z.object({
      status: z.literal("recovery_required"),
      inject: operationSchema,
      revert: operationSchema.optional(),
      revertAt: z.number(),
      reason: z.string(),
    }),
    z.object({
      status: z.literal("revert_command_completed"),
      inject: operationSchema,
      revert: operationSchema,
      revertAt: z.number(),
    }),
  ]),
);
export type DisruptionExecution = z.infer<typeof disruptionExecutionSchema>;
export type ExecutionStatus = DisruptionExecution["status"];
export const terminalExecution = (status: ExecutionStatus): boolean =>
  ["skipped", "failed", "revert_command_completed"].includes(status);

export interface DisruptionRequest {
  readonly eventId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly input: DisruptionFireRequest;
  readonly auditId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly targetTeamIds: string[];
  readonly parameters: Record<string, unknown>;
  readonly dueAt: number;
  readonly endsAt: number;
  readonly cancelled: boolean;
  /** Legacy metadata is preserved unchanged; it has no role in runtime recovery. */
  readonly acceptedAudit?: unknown;
}
