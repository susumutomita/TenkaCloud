import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Context,
  type EngineResult,
  HostError,
  isSolve,
  type Problem,
  type ScoreEvent,
} from "./model";
import { projectedScore } from "./score";

interface SubmissionDefinition {
  readonly kind: "submission";
  readonly edition: string;
  readonly instructions: string;
  readonly artifact: string;
  readonly points: number;
  readonly judge:
    | { readonly kind: "answer"; readonly digest: string }
    | { readonly kind: "self-report"; readonly checks: readonly string[] };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a submission catalog object.");
  return value as Record<string, unknown>;
};
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit)
    throw new Error("Invalid submission catalog text.");
  return value;
}

function catalogJudge(raw: unknown): SubmissionDefinition["judge"] {
  const input = record(raw);
  let judge: SubmissionDefinition["judge"];
  if (input.kind === "answer") judge = { kind: "answer", digest: hash(text(input.answer, 4096)) };
  else if (input.kind === "self-report") {
    const checks = input.checks;
    if (!Array.isArray(checks) || checks.length < 2 || checks.length > 20)
      throw new Error("A repair report needs normal-functionality and security checks.");
    const names = checks.map((check) => text(check, 80));
    if (
      !names.includes("normal-functionality") ||
      !names.includes("security") ||
      new Set(names).size !== names.length
    )
      throw new Error("Repair checks must include normal-functionality and security.");
    judge = { kind: "self-report", checks: names };
  } else throw new Error("Unknown submission judge.");
  return judge;
}

/** Explicit organizer input; never downloaded, executed, or reloaded during an event. */
export function submissionCatalog(path: string | undefined): readonly Problem[] {
  if (!path) return [];
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Submission catalog is too large.");
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 40) throw new Error("Invalid submission catalog.");
  const seen = new Set<string>();
  return rows.map((row) => {
    const entry = record(row);
    const problemId = text(entry.problemId, 100);
    if (!/^[a-z][a-z0-9-]*$/u.test(problemId) || seen.has(problemId))
      throw new Error("Invalid or duplicate submission problem identity.");
    seen.add(problemId);
    const name = text(entry.name, 200);
    const instructions = text(entry.instructions, 16_384);
    const artifact = text(entry.artifact, 65_536);
    record(JSON.parse(artifact));
    const points = entry.points;
    if (
      typeof points !== "number" ||
      !Number.isSafeInteger(points) ||
      points < 1 ||
      points > 10_000
    )
      throw new Error("Submission points must be a fixed positive integer.");
    const judge = catalogJudge(entry.judge);
    const version = text(entry.version, 80);
    const edition = hash(
      JSON.stringify({
        problemId,
        version,
        name,
        instructions,
        artifact,
        points,
        judge: judge.kind === "answer" ? { kind: judge.kind } : judge,
      }),
    );
    return {
      problemId,
      name,
      runtime: "submission",
      definition: JSON.stringify({
        kind: "submission",
        edition,
        instructions,
        artifact,
        points,
        judge,
      } satisfies SubmissionDefinition),
    };
  });
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
    submission: {
      edition: saved.edition,
      artifact: saved.artifact,
      points: saved.points,
      solved,
      kind: saved.judge.kind,
      assurance: saved.judge.kind === "answer" ? "server-checked-answer" : "self-reported",
      ...(saved.judge.kind === "self-report" ? { checks: saved.judge.checks } : {}),
    },
  };
}

function checkSubmission(saved: SubmissionDefinition, flag: unknown): boolean {
  let input: Record<string, unknown>;
  try {
    input = record(JSON.parse(String(flag)));
  } catch {
    throw new HostError(400, "Expected a versioned submission envelope.");
  }
  if (input.edition !== saved.edition)
    throw new HostError(409, "Problem edition mismatch.", "edition_mismatch");
  const allowed = saved.judge.kind === "answer" ? ["edition", "answer"] : ["edition", "checks"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new HostError(
      400,
      "Unsupported submission fields; URLs, code and client scores are not accepted.",
    );
  let correct: boolean;
  if (saved.judge.kind === "answer") {
    if (typeof input.answer !== "string" || Buffer.byteLength(input.answer) > 4096)
      throw new HostError(400, "Invalid answer.");
    correct = timingSafeEqual(
      Buffer.from(hash(input.answer), "hex"),
      Buffer.from(saved.judge.digest, "hex"),
    );
  } else {
    let checks: Record<string, unknown>;
    try {
      checks = record(input.checks);
    } catch {
      throw new HostError(400, "Invalid self-report checks.");
    }
    if (
      Object.keys(checks).length !== saved.judge.checks.length ||
      saved.judge.checks.some((name) => typeof checks[name] !== "boolean")
    )
      throw new HostError(400, "Report every pinned check as a boolean.");
    correct = saved.judge.checks.every((name) => checks[name] === true);
  }
  return correct;
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
  const correct = checkSubmission(saved, body.flag);
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
