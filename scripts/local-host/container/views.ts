import { StatusCodes } from "http-status-codes";
import { LOCAL_INTRO_DRILL_PROBLEM_ID } from "../../lib/intro-drill";
import type { ContainerCheck, ContainerHintRevealMode } from "../../lib/problem-presentation";
import { hintViews } from "../../lib/problem-presentation";
import { mapStrings } from "./port-remap";
import type { ProblemStatus } from "./problem-lifecycle";
import {
  type ContainerState,
  jobIdOf,
  LOCAL_CONTEXT,
  type LocalPlayResponse,
  type ProblemRuntime,
} from "./state";

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
      input: check.input,
      points: check.points,
      solved: runtime.solved.has(check.id),
      ...(check.i18n ? { i18n: check.i18n } : {}),
      ...(check.hints.length > 0 ? { hints: hintViews(runtime.revealedHints, check.hints) } : {}),
    })),
  };
}

/** Whether every submission target of a problem is solved (gates the writeup). */
export function isProblemComplete(runtime: ProblemRuntime): boolean {
  const scoring = runtime.problem.scoring;
  if (scoring.kind === "verify") return runtime.solved.has(runtime.problem.problemId);
  return scoring.checks.every((check) => runtime.solved.has(check.id));
}

function localScoringView(runtime: ProblemRuntime, complete: boolean) {
  const scoring = runtime.problem.scoring;
  if (scoring.kind === "verify") {
    return {
      kind: "flag" as const,
      points: scoring.points,
      flagSubmitted: complete,
      hints: hintViews(runtime.revealedHints, scoring.hints),
      ...(scoring.hintReveal ? { hintReveal: scoring.hintReveal } : {}),
    };
  }
  return multiVerifyScoringView(runtime, scoring.checks, scoring.totalPoints, scoring.hintReveal);
}

export function problemView(
  runtime: ProblemRuntime,
  now: number,
  status: ProblemStatus,
  cleanupRequired: boolean,
  lastError: string | undefined,
  browserText: (text: string) => string,
) {
  const problem = mapStrings(runtime.problem, browserText);
  const complete = isProblemComplete(runtime);
  // Local mode is a drill: reveal the writeup immediately after the whole problem is solved.
  const writeup = complete ? problem.writeup : undefined;
  // [fairness contract / platform #1124] `description` is the admin/authoring
  // field — SCHEMA.json defines it as "採点ルール / hardened state / 段階詳細など
  // ネタバレを含む長文" and states it is never shown to a competitor. Only
  // `instructions` / `shortDescription` are participant-facing. The en overlay
  // drops it for the same reason; this mirrors `sanitizeI18n()` in
  // apps/participant-portal/src/data/problems.ts (the build-time projection).
  const { description, ...englishOverlay } = problem.i18n?.en ?? {};
  const englishWriteup = complete ? problem.writeupI18n : undefined;
  const englishText = {
    ...englishOverlay,
    ...(englishWriteup ? { writeup: englishWriteup } : {}),
  };
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    instructions: problem.instructions,
    // [#2696 PR5] The platform's one fixed intro drill — the portal pins this
    // problem first and shows a "start here" badge on it. Every other problem
    // omits the field.
    ...(problem.problemId === LOCAL_INTRO_DRILL_PROBLEM_ID ? { recommended: true as const } : {}),
    ...(writeup ? { writeup } : {}),
    // #2054 i18n: ship the en overlay so the portal locale switcher can render
    // the problem in English (ja stays the top-level canonical).
    ...(Object.keys(englishText).length > 0 ? { i18n: { en: englishText } } : {}),
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    // [#2392 Phase 2] on-demand container state — the portal renders its
    // start / stop affordance from this field.
    lifecycle: {
      status,
      runtimeKind: "docker" as const,
      // [#2850] Present only when the problem's metadata opts into the container
      // terminal; the portal renders the terminal panel from this flag alone.
      ...(problem.terminal ? { terminal: true as const } : {}),
      ...(cleanupRequired ? { cleanupRequired: true as const } : {}),
      // 非同期 start (202) の失敗理由。 compose stderr は loopback URL を含み得るので
      // browserText (= Codespaces の forwarded origin 書き換え) を通す。
      ...(status === "error" && lastError ? { lastError: browserText(lastError) } : {}),
    },
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
    scoring: localScoringView(runtime, complete),
    deployLog: { cursor: "", entries: [] },
    createdAt: new Date(now).toISOString(),
  };
}

export function participantLifecycleStatus(
  status: ProblemStatus | undefined,
): Exclude<ProblemStatus, "stopping"> {
  // The public contract has one transitional/loading state. Keep teardown from
  // being misrendered as stopped (which would expose a premature Start action).
  return status === "stopping" ? "starting" : (status ?? "stopped");
}

export function containerProblemViews(state: ContainerState, now: number) {
  return [...state.runtimes].map(([problemId, runtime]) =>
    problemView(
      runtime,
      now,
      participantLifecycleStatus(state.lifecycle.statusOf(problemId)),
      state.lifecycle.cleanupRequired(problemId),
      state.lifecycle.errorOf(problemId),
      state.browserText,
    ),
  );
}
export function teamView(state: ContainerState, now: number): LocalPlayResponse {
  return {
    status: StatusCodes.OK,
    body: {
      team: {
        teamName: state.teamName,
        teamNameSetByCompetitor: true,
        eventId: LOCAL_CONTEXT.eventId,
        teamId: LOCAL_CONTEXT.teamId,
      },
      problems: containerProblemViews(state, now),
      eventGate: { kind: "ok" },
    },
  };
}
