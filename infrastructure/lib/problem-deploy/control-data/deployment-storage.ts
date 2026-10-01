import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { assertCommercialRegion } from "../../cloud-hosting/regions.js";
import {
  contentDigest,
  type DeploymentConnection,
  type DeploymentJob,
} from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { deploymentSchema, eventKey, teamKey } from "./dynamodb-cloud-repository.js";
export type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
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
});
export function creationKey(jobId: string, attempt: number) {
  return { ...jobKey(jobId), SK: `CREATE#${attempt}` };
}
export function teardownKey(jobId: string) {
  return { ...jobKey(jobId), SK: "TEARDOWN" };
}
export function teardownDispatchKey(jobId: string, attempt: number, generation: number) {
  return { PK: "DISPATCH#PENDING", SK: `${id.parse(jobId)}#${attempt}#DELETE#${generation}` };
}
export function closingEventGuard(table: string, eventId: string): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: eventKey(eventId),
      ConditionExpression: "#status = :closing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closing": "TEARDOWN" },
    },
  };
}
export const receiptSchema = z.object({ requestHash: z.string(), response: z.unknown() });
export function jobKey(jobId: string) {
  return { PK: `DEPLOYMENT#${id.parse(jobId)}`, SK: "META" };
}
export function targetKey(eventId: string, teamId: string, problemId: string) {
  return {
    PK: `EVENT#${id.parse(eventId)}#TEAM#${id.parse(teamId)}`,
    SK: `TARGET#${contentDigest(problemId)}`,
  };
}
export function receiptKey(eventId: string, teamId: string, operation: string, key: string) {
  if (!key || key.length > 255) throw new Error("Request key must contain 1-255 characters.");
  return {
    PK: `EVENT#${id.parse(eventId)}#TEAM#${id.parse(teamId)}`,
    SK: `RECEIPT#${operation}#${contentDigest(key)}`,
  };
}
export function dispatchKey(jobId: string, attempt: number) {
  return { PK: "DISPATCH#PENDING", SK: `${id.parse(jobId)}#${attempt}` };
}
export function scoreKey(eventId: string, teamId: string) {
  return { ...eventKey(eventId), SK: `SCORE#${id.parse(teamId)}` };
}
export function connectionKey(eventId: string, teamId: string) {
  return { ...eventKey(eventId), SK: `CONNECTION#${id.parse(teamId)}` };
}
export function indexedJob(job: DeploymentJob) {
  return {
    ...job,
    ...jobKey(job.jobId),
    GSI1PK: `EVENT#${job.eventId}`,
    GSI1SK: `TEAM#${job.teamId}#PROBLEM#${job.problemId}`,
  };
}
export function teamGuard(table: string, team: TeamRecord, now: number): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: teamKey(team.eventId, team.teamId),
      ConditionExpression: "authVersion = :version AND accessRevoked = :no AND expiresAt > :now",
      ExpressionAttributeValues: {
        ":version": team.authVersion,
        ":no": false,
        ":now": Math.floor(now / 1000),
      },
    },
  };
}
export function eventGuard(table: string, event: EventRecord, now: number, scoring = false): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: eventKey(event.eventId),
      ConditionExpression:
        "updatedAt = :at AND expiresAt > :now AND #status IN (:draft, :deploying, :ready)" +
        (scoring
          ? " AND (attribute_not_exists(scoringLocked) OR scoringLocked = :no) AND startsAt <= :iso AND (attribute_not_exists(endsAt) OR endsAt > :iso)"
          : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":at": event.updatedAt,
        ":now": Math.floor(now / 1000),
        ":draft": "DRAFT",
        ":deploying": "DEPLOYING",
        ":ready": "READY",
        ...(scoring ? { ":no": false, ":iso": new Date(now).toISOString() } : {}),
      },
    },
  };
}
export function connectionGuard(table: string, connection: DeploymentConnection): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: connectionKey(connection.eventId, connection.teamId),
      ConditionExpression: "version = :version AND roleArn = :role AND verifiedAt = :at",
      ExpressionAttributeValues: {
        ":version": connection.version,
        ":role": connection.roleArn,
        ":at": connection.verifiedAt,
      },
    },
  };
}
