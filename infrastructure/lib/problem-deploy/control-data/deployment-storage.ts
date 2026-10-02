import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  contentDigest,
  type DeploymentConnection,
  type DeploymentJob,
} from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { eventKey, teamKey } from "./dynamodb-cloud-repository.js";
export type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export function creationKey(jobId: string, attempt: number) {
  return { ...jobKey(jobId), SK: `CREATE#${attempt}` };
}
export function teardownKey(jobId: string, historicalAttempt?: number) {
  if (
    historicalAttempt !== undefined &&
    (!Number.isSafeInteger(historicalAttempt) || historicalAttempt < 1)
  )
    throw new Error("Invalid historical teardown attempt.");
  return {
    ...jobKey(jobId),
    SK: historicalAttempt === undefined ? "TEARDOWN" : `TEARDOWN#${historicalAttempt}`,
  };
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

export {
  connectionSchema,
  creationSchema,
  jobSchema,
  receiptSchema,
  teardownSchema,
} from "./deployment-work-records.js";
