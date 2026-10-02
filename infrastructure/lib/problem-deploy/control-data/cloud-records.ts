import { createHash } from "node:crypto";
import { z } from "zod";

export const scoreSchema = z.object({
  eventId: z.string(),
  teamId: z.string(),
  score: z.number().finite(),
  completedProblems: z.number().int().nonnegative(),
});
export const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
export const KEY = /^[A-Za-z0-9_-]{43}$/u;
export const digest = (key: string): string => createHash("sha256").update(key).digest("hex");
export const teamSchema = z.object({
  eventId: z.string().regex(ID),
  teamId: z.string().regex(ID),
  internalSlug: z.string(),
  displayName: z.string().optional(),
  awsAccountId: z.string().optional(),
  region: z.string().optional(),
  teamLoginKey: z.string().regex(KEY),
  authVersion: z.number().int().positive(),
  accessRevoked: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.number().finite(),
});
export const eventSchema = z.object({
  eventId: z.string().regex(ID),
  name: z.string(),
  status: z.enum(["DRAFT", "DEPLOYING", "READY", "ENDED", "TEARDOWN", "ARCHIVED"]),
  problems: z.array(
    z.object({
      problemId: z.string(),
      defaultRegion: z.string(),
      defaultAwsAccountId: z.string().optional(),
    }),
  ),
  teamCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.number().finite(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  scoringLocked: z.boolean().optional(),
  scoreboardFreezeMinutes: z.number().optional(),
  teardownExpected: z.number().int().nonnegative().optional(),
  teardownCompleted: z.number().int().nonnegative().optional(),
});
