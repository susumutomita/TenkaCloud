import { StatusCodes } from "http-status-codes";
import {
  jobIdOf,
  LOCAL_CONTEXT,
  type LocalPlayResponse,
  type LocalPlayState,
  type ProblemRuntime,
  sessionScore,
} from "./api-state";
import type { ContainerCheck, ContainerHint, ContainerHintRevealMode } from "./manifest";
import { mapStrings } from "./port-remap";
import type { ProblemStatus } from "./problem-lifecycle";

/**
 * [#2527 Slice 6] Portal presentation for the local scoring API, extracted verbatim from
 * `api.ts`: the problem / team / leaderboard view builders (incl. the multi-verify →
 * multi-flag portal mapping, #2252, and reveal-gated hint views). Pure reads over
 * {@link LocalPlayState} — no mutation, no routing.
 */

function hintViews(runtime: ProblemRuntime, hints: readonly ContainerHint[]) {
  return hints.map((hint) => {
    const revealedAt = runtime.revealedHints.get(hint.id);
    return {
      id: hint.id,
      penalty: hint.penalty,
      revealed: revealedAt !== undefined,
      // Keep the translated content gated behind reveal too — never leak the
      // hint in any language before it is unlocked.
      ...(revealedAt
        ? { content: hint.content, revealedAt, ...(hint.i18n ? { i18n: hint.i18n } : {}) }
        : {}),
    };
  });
}

/**
 * [#2252] multi-verify renders through the portal's existing multi-flag view:
 * each checkpoint becomes a `flags[]` entry ({ id, label, points, solved }) so
 * `MultiFlagSubmissionPanel` / `submitFlag(..., flagId)` are reused as-is — no
 * new portal scoring kind. Per-check hints ride on the optional `hints` field.
 */
function multiVerifyScoringView(
  runtime: ProblemRuntime,
  checks: readonly ContainerCheck[],
  totalPoints: number,
  hintReveal: ContainerHintRevealMode | undefined,
) {
  return {
    kind: "multi-flag",
    points: totalPoints,
    // 順序ゲートを外す flat の問題だけ露出 (既定 sequential は送らない)。 portal の
    // HintsPanel がこれを見て各 sub-flag の hint lock を外す。
    ...(hintReveal ? { hintReveal } : {}),
    flags: checks.map((check) => ({
      id: check.id,
      label: check.label,
      points: check.points,
      solved: runtime.solved.has(check.id),
      ...(check.i18n ? { i18n: check.i18n } : {}),
      ...(check.hints.length > 0 ? { hints: hintViews(runtime, check.hints) } : {}),
    })),
  };
}

/** Whether every submission target of a problem is solved (gates the writeup). */
function isProblemComplete(runtime: ProblemRuntime): boolean {
  const scoring = runtime.problem.scoring;
  if (scoring.kind === "verify") return runtime.solved.has(runtime.problem.problemId);
  return scoring.checks.every((check) => runtime.solved.has(check.id));
}

function problemView(
  runtime: ProblemRuntime,
  now: number,
  status: ProblemStatus,
  browserText: (text: string) => string,
) {
  const problem = mapStrings(runtime.problem, browserText);
  const complete = isProblemComplete(runtime);
  const englishText = {
    ...(problem.i18n?.en ?? {}),
    ...(complete && problem.writeupI18n ? { writeup: problem.writeupI18n } : {}),
  };
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    description: problem.description,
    instructions: problem.instructions,
    // Local mode is a drill: reveal immediately after the whole problem is solved.
    ...(complete && problem.writeup ? { writeup: problem.writeup } : {}),
    // #2054 i18n: ship the en overlay so the portal locale switcher can render
    // the problem in English (ja stays the top-level canonical).
    ...(Object.keys(englishText).length > 0 ? { i18n: { en: englishText } } : {}),
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    // [#2392 Phase 2] on-demand container state — the portal renders its
    // start / stop affordance from this field.
    lifecycle: { status },
    // The challenge surface URLs the participant attacks (loopback only). A
    // stopped problem must not leak (stale) endpoints of a down container.
    stackOutputs: status === "running" ? problem.challengeEndpoints : {},
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    // [#2392] running per-problem score incl. hint / wrong-answer penalties (the
    // header total is the sum, matching the leaderboard).
    score: runtime.score,
    ...(complete ? { lastResult: "ok" as const } : {}),
    // Participant-facing view: single submission box ("flag") for verify, the
    // existing multi-flag shape for multi-verify. Scoring stays delegated.
    scoring:
      problem.scoring.kind === "verify"
        ? {
            kind: "flag",
            points: problem.scoring.points,
            flagSubmitted: complete,
            hints: hintViews(runtime, problem.scoring.hints),
            ...(problem.scoring.hintReveal ? { hintReveal: problem.scoring.hintReveal } : {}),
          }
        : multiVerifyScoringView(
            runtime,
            problem.scoring.checks,
            problem.scoring.totalPoints,
            problem.scoring.hintReveal,
          ),
    deployLog: { cursor: "", entries: [] },
    createdAt: new Date(now).toISOString(),
  };
}

export function teamView(state: LocalPlayState, now: number): LocalPlayResponse {
  return {
    status: StatusCodes.OK,
    body: {
      team: {
        teamName: state.teamName,
        teamNameSetByCompetitor: true,
        eventId: LOCAL_CONTEXT.eventId,
        teamId: LOCAL_CONTEXT.teamId,
      },
      problems: [...state.runtimes.entries()].map(([problemId, runtime]) =>
        problemView(
          runtime,
          now,
          state.lifecycle.statusOf(problemId) ?? "stopped",
          state.browserText,
        ),
      ),
      eventGate: { kind: "ok" },
    },
  };
}

export function leaderboard(state: LocalPlayState): LocalPlayResponse {
  // [#2252/#2392] a multi-verify problem counts as complete only when every
  // checkpoint is solved; the session may hold several problems.
  const runtimes = [...state.runtimes.values()];
  const completed = runtimes.filter((rt) => isProblemComplete(rt)).length;
  return {
    status: StatusCodes.OK,
    body: {
      eventId: LOCAL_CONTEXT.eventId,
      entries: [
        {
          rank: 1,
          teamId: LOCAL_CONTEXT.teamId,
          teamName: state.teamName,
          score: sessionScore(state),
          completedProblems: completed,
          totalProblems: state.runtimes.size,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    },
  };
}
