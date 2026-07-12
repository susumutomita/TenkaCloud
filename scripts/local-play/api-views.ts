import { StatusCodes } from "http-status-codes";
import type { SimulatedProblemRuntime } from "./api-state";
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
import { participantSimulatorOutputs } from "./simulator-scoring";

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

function simulatedProblemView(
  runtime: SimulatedProblemRuntime,
  now: number,
  status: ProblemStatus,
  browserText: (text: string) => string,
) {
  const problem = runtime.problem;
  const participantOutputs = runtime.deployment
    ? participantSimulatorOutputs(problem, runtime.deployment.outputs)
    : {};
  const outputs = runtime.deployment
    ? {
        ...Object.fromEntries(
          Object.entries(participantOutputs).map(([key, value]) => [key, browserText(value)]),
        ),
        SimulatorConsoleUrl: browserText(runtime.deployment.consoleUrl),
        SimulatorAwsAccessKeyId: runtime.deployment.nativeCredentials.awsAccessKeyId,
        SimulatorAzureCredential: runtime.deployment.nativeCredentials.azureCredential,
        SimulatorGcpCredential: runtime.deployment.nativeCredentials.gcpCredential,
        SimulatorSakuraCredential: runtime.deployment.nativeCredentials.sakuraCredential,
      }
    : {};
  const provider = "kind" in problem.runtime ? "composite" : problem.runtime.provider;
  const scoring = simulatorScoringView(runtime);
  const health = simulatorApplicationStatus(runtime.endpointsHealth);
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    description: problem.description,
    instructions: problem.instructions,
    region: "local",
    awsAccountId: "local",
    provider,
    status: "COMPLETE",
    lifecycle: { status },
    stackOutputs: status === "running" ? outputs : {},
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    score: runtime.score,
    ...(scoring ? { scoring } : {}),
    ...(health ? { applicationStatus: health } : {}),
    ...(runtime.platform ? { platform: runtime.platform } : {}),
    ...(runtime.lastResult ? { lastResult: runtime.lastResult } : {}),
    deployLog: { cursor: "", entries: [] },
    createdAt: new Date(now).toISOString(),
  };
}

function simulatorHintViews(runtime: SimulatedProblemRuntime) {
  const scoring = runtime.contract.scoring;
  const hints = "hints" in scoring ? (scoring.hints ?? []) : [];
  return hints.map((hint) => {
    const revealedAt = runtime.revealedHints.get(hint.id);
    return {
      id: hint.id,
      penalty: hint.penalty,
      revealed: revealedAt !== undefined,
      ...(revealedAt ? { content: hint.content, revealedAt } : {}),
    };
  });
}

function simulatorScoringView(runtime: SimulatedProblemRuntime) {
  const scoring = runtime.contract.scoring;
  const hints = simulatorHintViews(runtime);
  if (scoring.kind === "flag") {
    return {
      kind: "flag",
      points: scoring.points,
      flagSubmitted: runtime.solved.has(runtime.problem.problemId),
      hints,
      ...(scoring.hintReveal ? { hintReveal: scoring.hintReveal } : {}),
    };
  }
  if (scoring.kind === "uptime" || scoring.kind === "uptime-flat") {
    return { kind: scoring.kind, pointsPerSuccess: scoring.pointsPerSuccess, hints };
  }
  if (scoring.kind === "uptime-multi") {
    return { kind: "uptime-multi", pointsAllOk: scoring.pointsAllOk, hints };
  }
  if (scoring.kind === "phased-polling") {
    const points = Math.max(...Object.values(scoring.platformRules).map((rule) => rule.points));
    return { kind: "phased-polling", pointsPerSuccess: points, hints };
  }
  if (scoring.kind === "attack-detection") {
    return { kind: "attack-detection", pointsPerAttack: scoring.pointsPerAttack, hints };
  }
  if (scoring.kind === "composite-probe") {
    return { kind: "uptime-multi", pointsAllOk: scoring.pointsAllOk };
  }
  return undefined;
}

function simulatorApplicationStatus(raw: string | undefined) {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.values(value as Record<string, unknown>).filter(
    (entry): entry is { ok: boolean; checkedAt: string } =>
      !!entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { ok?: unknown }).ok === "boolean" &&
      typeof (entry as { checkedAt?: unknown }).checkedAt === "string",
  );
  if (entries.length === 0) return undefined;
  const healthyCount = entries.filter((entry) => entry.ok).length;
  return {
    overall: healthyCount === entries.length ? "healthy" : healthyCount > 0 ? "degraded" : "down",
    healthyCount,
    totalCount: entries.length,
    checkedAt: entries
      .map((entry) => entry.checkedAt)
      .sort()
      .at(-1),
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
      problems: [
        ...[...state.runtimes.entries()].map(([problemId, runtime]) =>
          problemView(
            runtime,
            now,
            state.lifecycle.statusOf(problemId) ?? "stopped",
            state.browserText,
          ),
        ),
        ...[...state.simulatedRuntimes.entries()].map(([problemId, runtime]) =>
          simulatedProblemView(
            runtime,
            now,
            state.lifecycle.statusOf(problemId) ?? "stopped",
            state.browserText,
          ),
        ),
      ],
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
          totalProblems: state.runtimes.size + state.simulatedRuntimes.size,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    },
  };
}
