import type { DeploymentCompletion } from "./domain/deployment-work.js";
import {
  type CreationReservation,
  DeploymentConflict,
  type DeploymentIdentity,
  type DeploymentJob,
  type FlagOutcome,
  flagMatchesDigest,
  type TeardownRecord,
} from "./domain/deployment-work.js";
export function pristineCreation(
  job: DeploymentJob,
  creation: CreationReservation | undefined,
): boolean {
  return (
    job.stackId === undefined &&
    creation?.state === "NOT_STARTED" &&
    creation.leaseUntil === 0 &&
    creation.owner === undefined &&
    creation.stackId === undefined &&
    creation.fingerprint === undefined
  );
}
export function sameCreationReference(
  job: DeploymentJob,
  creation: CreationReservation | undefined,
  reference: { readonly stackId: string; readonly fingerprint: string },
): boolean {
  return (
    (job.stackId === undefined || job.stackId === reference.stackId) &&
    (creation?.stackId === undefined || creation.stackId === reference.stackId) &&
    (creation?.fingerprint === undefined || creation.fingerprint === reference.fingerprint)
  );
}

export function checkTeardownScope(record: TeardownRecord, identity: DeploymentIdentity): void {
  if (
    record.jobId !== identity.jobId ||
    record.eventId !== identity.eventId ||
    record.teamId !== identity.teamId ||
    record.attempt !== identity.attempt ||
    (identity.generation !== undefined && identity.generation !== record.generation)
  )
    throw new DeploymentConflict("teardown_scope_or_generation_changed");
}
export function validateHistoryCounts(record: TeardownRecord): void {
  if (
    record.parentAttempt !== undefined ||
    (record.historyExpected === undefined) !== (record.historyCompleted === undefined) ||
    (record.historyExpected !== undefined &&
      (record.historyExpected !== record.attempt - 1 ||
        record.historyCompleted === undefined ||
        record.historyCompleted > record.historyExpected))
  )
    throw new DeploymentConflict("teardown_history_scope_changed");
}
export function verifyReferenceForJob(
  job: DeploymentJob,
  reference: { readonly stackId: string; readonly fingerprint: string },
): void {
  const prefix = `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/`;
  if (
    !reference.stackId.startsWith(prefix) ||
    !/^[A-Za-z0-9-]+$/u.test(reference.stackId.slice(prefix.length)) ||
    !/^[a-f0-9]{64}$/u.test(reference.fingerprint)
  )
    throw new DeploymentConflict("stack_reference_scope_changed");
}
export function validateCompletion(job: DeploymentJob, completion: DeploymentCompletion): void {
  if (completion.status === "FAILED") {
    if (!completion.failureReason || completion.failureReason.length > 2000)
      throw new Error("A bounded failure reason is required.");
    return;
  }
  if (
    !completion.stackId?.startsWith(
      `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/`,
    ) ||
    !/^[a-f0-9]{64}$/u.test(completion.flagDigest ?? "")
  )
    throw new Error("Completion requires an owned stack ARN and verifier flag digest.");
  if (
    completion.publicOutputs?.[job.scoring.flagOutputKey] !== undefined ||
    Object.keys(completion.publicOutputs ?? {}).length > 20 ||
    Object.values(completion.publicOutputs ?? {}).some((value) => value.length > 4096)
  )
    throw new Error("Public deployment outputs exceed bounds.");
}
export function scoreOutcome(job: DeploymentJob, flag: string): FlagOutcome {
  if (job.flagSubmitted) return { kind: "already_scored", totalScore: job.score };
  const correct = flagMatchesDigest(flag, job.flagDigest ?? "");
  const totalScore = Math.max(
    0,
    job.score + (correct ? job.scoring.points : -job.scoring.wrongPenalty),
  );
  return { kind: correct ? "ok" : "wrong", scoreDelta: totalScore - job.score, totalScore };
}
