import { z } from "zod";
import { assertCommercialRegion } from "../../cloud-hosting/regions.js";
import { deploymentSchema } from "./deployment-records.js";

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const connectionSchema = z
  .object({
    eventId: id,
    teamId: id,
    accountId: z.string().regex(/^\d{12}$/u),
    region: z.string(),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@/_-]+$/u),
    externalIdParameter: z.string().min(1),
    version: z.number().int().positive(),
    verifiedAt: z.string().datetime(),
    bindingId: z.string().optional(),
    registrationId: id.optional(),
    reviewedProblemIds: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    assertCommercialRegion(value.region);
    if (
      !value.roleArn.startsWith(`arn:aws:iam::${value.accountId}:role/`) ||
      !/^arn:aws:ssm:[a-z]{2}(?:-[a-z]+)+-\d+:\d{12}:parameter\/[A-Za-z0-9/_.-]+$/u.test(
        value.externalIdParameter,
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid verified connection binding.",
      });
  });
export const jobSchema = deploymentSchema.extend({
  attempt: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stackName: z.string().regex(/^tc-cloud-[a-f0-9]{40}$/u),
  problemDir: z.string().regex(/^problems\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/u),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  catalogKey: z.string().optional(),
  parameters: z.record(z.string()).optional(),
  completionDigest: z.string().optional(),
  connection: connectionSchema,
  scoring: z.object({
    kind: z.literal("flag"),
    points: z.number().int().positive().max(1_000_000),
    flagOutputKey: z.string().min(1).max(128),
    wrongPenalty: z.number().int().nonnegative().max(1_000_000),
  }),
  owner: z.string().optional(),
  stackId: z.string().optional(),
  flagDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  flagSubmitted: z.boolean().optional(),
  completedAt: z.string().datetime().optional(),
  failureReason: z.string().optional(),
  publicOutputs: z.record(z.string()).optional(),
});
const operationIdentity = {
  eventId: id,
  teamId: id,
  jobId: id,
  attempt: z.number().int().positive(),
};
export const creationSchema = z.object({
  ...operationIdentity,
  state: z.enum(["NOT_STARTED", "REQUESTED", "ACKNOWLEDGED"]),
  owner: z.string().optional(),
  leaseUntil: z.number().finite(),
  stackId: z.string().optional(),
  fingerprint: z.string().optional(),
});
export const teardownSchema = z.object({
  ...operationIdentity,
  generation: z.number().int().positive(),
  status: z.enum(["PENDING", "IN_PROGRESS", "FAILED", "DELETED"]),
  owner: z.string().optional(),
  fingerprint: z.string().optional(),
  requestedAt: z.string(),
  updatedAt: z.string(),
  failureReason: z.string().optional(),
  stackId: z.string().optional(),
  parentAttempt: z.number().int().positive().optional(),
  historyExpected: z.number().int().nonnegative().optional(),
  historyCompleted: z.number().int().nonnegative().optional(),
});
export const receiptSchema = z.object({ requestHash: z.string(), response: z.unknown() });
