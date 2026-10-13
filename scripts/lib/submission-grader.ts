import { createHash, timingSafeEqual } from "node:crypto";
import type { ParticipantProblemView } from "../../packages/portal-contracts/src/index";

export class SubmissionInputError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
    readonly code = "request_failed",
  ) {
    super(message);
  }
}
export interface SubmissionCatalogEntry {
  readonly problemId: string;
  readonly name: string;
  readonly definition: SubmissionDefinition;
}
export interface SubmissionDefinition {
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
export function parseSubmissionCatalog(raw: string): readonly SubmissionCatalogEntry[] {
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
      definition: {
        kind: "submission",
        edition,
        instructions,
        artifact,
        points,
        judge,
      } satisfies SubmissionDefinition,
    };
  });
}

export function judgeSubmission(saved: SubmissionDefinition, flag: unknown): boolean {
  let input: Record<string, unknown>;
  try {
    input = record(JSON.parse(String(flag)));
  } catch {
    throw new SubmissionInputError(400, "Expected a versioned submission envelope.");
  }
  if (input.edition !== saved.edition)
    throw new SubmissionInputError(409, "Problem edition mismatch.", "edition_mismatch");
  const allowed = saved.judge.kind === "answer" ? ["edition", "answer"] : ["edition", "checks"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new SubmissionInputError(
      400,
      "Unsupported submission fields; URLs, code and client scores are not accepted.",
    );
  let correct: boolean;
  if (saved.judge.kind === "answer") {
    if (typeof input.answer !== "string" || Buffer.byteLength(input.answer) > 4096)
      throw new SubmissionInputError(400, "Invalid answer.");
    correct = timingSafeEqual(
      Buffer.from(hash(input.answer), "hex"),
      Buffer.from(saved.judge.digest, "hex"),
    );
  } else {
    let checks: Record<string, unknown>;
    try {
      checks = record(input.checks);
    } catch {
      throw new SubmissionInputError(400, "Invalid self-report checks.");
    }
    if (
      Object.keys(checks).length !== saved.judge.checks.length ||
      saved.judge.checks.some((name) => typeof checks[name] !== "boolean")
    )
      throw new SubmissionInputError(400, "Report every pinned check as a boolean.");
    correct = saved.judge.checks.every((name) => checks[name] === true);
  }
  return correct;
}

export function publicSubmission(
  saved: SubmissionDefinition,
  solved: boolean,
): NonNullable<ParticipantProblemView["submission"]> {
  return {
    edition: saved.edition,
    artifact: saved.artifact,
    points: saved.points,
    solved,
    kind: saved.judge.kind,
    assurance: saved.judge.kind === "answer" ? "server-checked-answer" : "self-reported",
    ...(saved.judge.kind === "self-report" ? { checks: saved.judge.checks } : {}),
  };
}
