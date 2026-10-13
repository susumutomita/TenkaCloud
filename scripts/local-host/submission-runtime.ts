import { readFileSync } from "node:fs";
import {
  judgeSubmission,
  parseSubmissionCatalog,
  publicSubmission,
  type SubmissionDefinition,
  SubmissionInputError,
} from "../lib/submission-grader";
import {
  type Context,
  type EngineResult,
  HostError,
  isSolve,
  type Problem,
  type ScoreEvent,
} from "./model";
import { projectedScore } from "./score";

export function submissionCatalog(path: string | undefined): readonly Problem[] {
  if (!path) return [];
  return parseSubmissionCatalog(readFileSync(path, "utf8")).map((entry) => ({
    ...entry,
    runtime: "submission",
    definition: JSON.stringify(entry.definition),
  }));
}

export function submissionDefinition(problem: {
  readonly definition: string;
}): SubmissionDefinition {
  const saved = JSON.parse(problem.definition) as SubmissionDefinition;
  if (saved.kind !== "submission") throw new Error("Not a pinned submission problem.");
  return saved;
}

export function submissionProblemView(problem: Problem, context: Context): Record<string, unknown> {
  const saved = submissionDefinition(problem);
  const solved = context.team.scoreEvents.some(
    (event) => event.problemId === problem.problemId && isSolve(event),
  );
  return {
    problemId: problem.problemId,
    name: problem.name,
    runtimeKind: "submission",
    region: "local",
    awsAccountId: "local",
    instructions: saved.instructions,
    stackOutputs: {},
    deployLog: { cursor: "", entries: [] },
    submission: publicSubmission(saved, solved),
  };
}

function scoreEntry(
  context: Context,
  problem: Problem,
  saved: SubmissionDefinition,
  correct: boolean,
): ScoreEvent {
  const assurance: NonNullable<ScoreEvent["assurance"]> =
    saved.judge.kind === "answer" ? "server-checked-answer" : "self-reported";
  const answerSource = correct ? "flag" : "flag-wrong";
  return {
    jobId: context.jobs.find((job) => job.problemId === problem.problemId)?.jobId ?? "",
    problemId: problem.problemId,
    source: saved.judge.kind === "answer" ? answerSource : "self-report",
    points: correct ? saved.points : 0,
    result: correct ? ("ok" as const) : ("wrong" as const),
    occurredAt: new Date(context.now).toISOString(),
    assurance,
    edition: saved.edition,
  };
}

/** No network or execution capability: only a pinned answer or explicitly untrusted check report. */
export function submitStudy(context: Context, body: Record<string, unknown>): EngineResult {
  const problem = context.event.problems.find((entry) => entry.problemId === body.problemId);
  if (!problem) throw new HostError(404, "Unknown submission problem.");
  const saved = submissionDefinition(problem);
  let correct: boolean;
  try {
    correct = judgeSubmission(saved, body.flag);
  } catch (error) {
    if (error instanceof SubmissionInputError)
      throw new HostError(error.status, error.message, error.code);
    throw error;
  }
  const already = context.team.scoreEvents.some(
    (event) => event.problemId === problem.problemId && isSolve(event),
  );
  const assurance: NonNullable<ScoreEvent["assurance"]> =
    saved.judge.kind === "answer" ? "server-checked-answer" : "self-reported";
  const entries: ScoreEvent[] = already
    ? context.team.scoreEvents
    : [scoreEntry(context, problem, saved, correct), ...context.team.scoreEvents];
  const score = projectedScore(context.event, entries).total;
  const verdict = correct ? "ok" : "wrong";
  return {
    status: 200,
    body: {
      kind: already ? "already_scored" : verdict,
      wrongCount: entries.filter(
        (event) => event.problemId === problem.problemId && event.result === "wrong",
      ).length,
      scoreDelta: already || !correct ? 0 : saved.points,
      totalScore: score,
      assurance,
      edition: saved.edition,
    },
    snapshot: context.team.snapshot,
    score,
    completedProblems: new Set(entries.filter(isSolve).map((event) => event.problemId)).size,
    scoreEvents: entries,
  };
}
