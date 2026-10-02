import { z } from "zod";

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
export const deploymentSchema = z.object({
  jobId: z.string().regex(ID),
  eventId: z.string().regex(ID),
  teamId: z.string().regex(ID),
  problemId: z.string(),
  region: z.string(),
  awsAccountId: z.string(),
  status: z.enum([
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "FAILED",
    "DELETING",
    "DELETED",
    "EXPIRED",
    "AUTO_DELETED",
  ]),
  expiresAt: z.number().finite(),
  score: z.number().finite(),
  publicOutputs: z.record(z.string()).optional(),
  scoring: z.object({ kind: z.literal("flag"), points: z.number() }).optional(),
  flagSubmitted: z.boolean().optional(),
  failureReason: z.string().optional(),
  teardownStatus: z.enum(["PENDING", "IN_PROGRESS", "FAILED", "DELETED"]).optional(),
  teardownFailureReason: z.string().optional(),
  createdAt: z.string().optional(),
});
