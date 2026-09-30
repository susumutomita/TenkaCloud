import { StatusCodes } from "http-status-codes";
import { compareCodePoints } from "../lib/code-point-order";
import type { ProblemStatus } from "../local-host/container/problem-lifecycle";
import {
  jobIdOf,
  LOCAL_CONTEXT,
  type LocalPlayResponse,
  sessionScore,
} from "../local-host/container/state";
import {
  containerProblemViews,
  isProblemComplete,
  participantLifecycleStatus,
} from "../local-host/container/views";
import type { LocalPlayState, SimulatedProblemRuntime } from "./api-state";
import { participantSimulatorOutputs } from "./simulator-scoring";

function isSimulatedProblemComplete(runtime: SimulatedProblemRuntime): boolean {
  const scoring = runtime.contract.scoring;
  if (scoring.kind === "flag" || scoring.kind === "composite-probe") {
    return runtime.solved.has(runtime.problem.problemId);
  }
  return false;
}

function simulatedProblemView(
  runtime: SimulatedProblemRuntime,
  now: number,
  status: ProblemStatus,
  cleanupRequired: boolean,
  lastError: string | undefined,
  browserText: (text: string) => string,
) {
  const problem = runtime.problem;
  const participantOutputs = runtime.deployment
    ? participantSimulatorOutputs(problem, runtime.deployment.outputs)
    : {};
  const outputs = runtime.deployment
    ? Object.fromEntries(
        Object.entries(participantOutputs).map(([key, value]) => [key, browserText(value)]),
      )
    : {};
  const provider = "kind" in problem.runtime ? "composite" : problem.runtime.provider;
  const scoring = simulatorScoringView(runtime);
  const health = simulatorApplicationStatus(runtime.endpointsHealth);
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    // [fairness contract / platform #1124] admin/authoring `description` is
    // dropped here exactly as it is in problemView() above.
    instructions: problem.instructions,
    region: "local",
    awsAccountId: "local",
    provider,
    status: "COMPLETE",
    lifecycle: {
      status,
      runtimeKind: "simulated-cloud" as const,
      ...(cleanupRequired ? { cleanupRequired: true as const } : {}),
      ...(status === "error" && lastError ? { lastError: browserText(lastError) } : {}),
    },
    stackOutputs: status === "running" ? outputs : {},
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    score: runtime.score,
    ...(scoring ? { scoring } : {}),
    ...(health ? { applicationStatus: health } : {}),
    ...(runtime.platform ? { platform: runtime.platform } : {}),
    ...(runtime.lastResult ? { lastResult: runtime.lastResult } : {}),
    deployLog: { cursor: "", entries: [] },
    createdAt: runtime.createdAt ?? new Date(now).toISOString(),
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
    return { kind: "uptime-multi", pointsAllOk: scoring.pointsAllOk, hints };
  }
  return undefined;
}

function rollupHealth(healthyCount: number, totalCount: number): string {
  if (healthyCount === totalCount) return "healthy";
  return healthyCount > 0 ? "degraded" : "down";
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
    overall: rollupHealth(healthyCount, entries.length),
    healthyCount,
    totalCount: entries.length,
    checkedAt: entries
      .map((entry) => entry.checkedAt)
      .sort(compareCodePoints)
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
        ...containerProblemViews(state, now),
        ...[...state.simulatedRuntimes.entries()].map(([problemId, runtime]) =>
          simulatedProblemView(
            runtime,
            now,
            participantLifecycleStatus(state.lifecycle.statusOf(problemId)),
            state.lifecycle.cleanupRequired(problemId),
            state.lifecycle.errorOf(problemId),
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
  const completed =
    runtimes.filter((rt) => isProblemComplete(rt)).length +
    [...state.simulatedRuntimes.values()].filter((rt) => isSimulatedProblemComplete(rt)).length;
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
