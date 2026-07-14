import type {
  LocalPlayScoreEvent,
  LocalPlayState,
  ProblemRuntime,
  SimulatedProblemRuntime,
} from "./api-state";

export const LOCAL_PLAY_SNAPSHOT_VERSION = 1 as const;

interface ProblemProgressSnapshot {
  readonly solved: readonly string[];
  readonly revealedHints: readonly (readonly [string, string])[];
  readonly wrongCounts: readonly (readonly [string, number])[];
  readonly score: number;
}

interface SimulatedProblemProgressSnapshot extends ProblemProgressSnapshot {
  readonly overrides: readonly (readonly [string, string])[];
  readonly createdAt?: string;
  readonly scoringState: SimulatedProblemRuntime["scoringState"];
  readonly endpointsHealth?: string;
  readonly attackProbes?: string;
  readonly posture?: string;
  readonly platform?: string;
  readonly lastResult?: "ok" | "fail";
}

export interface LocalPlaySnapshot {
  readonly version: typeof LOCAL_PLAY_SNAPSHOT_VERSION;
  readonly teamName: string;
  readonly runtimes: Readonly<Record<string, ProblemProgressSnapshot>>;
  readonly simulatedRuntimes: Readonly<Record<string, SimulatedProblemProgressSnapshot>>;
  readonly scoreEvents: readonly LocalPlayScoreEvent[];
}

export interface LocalPlayStateStore {
  readonly description: string;
  readonly load: () => Promise<LocalPlaySnapshot | undefined>;
  readonly save: (snapshot: LocalPlaySnapshot) => Promise<void>;
  readonly close: () => Promise<void>;
}

function snapshotProgress(runtime: ProblemRuntime): ProblemProgressSnapshot {
  return {
    solved: [...runtime.solved],
    revealedHints: [...runtime.revealedHints],
    wrongCounts: [...runtime.wrongCounts],
    score: runtime.score,
  };
}

export function snapshotLocalPlayState(state: LocalPlayState): LocalPlaySnapshot {
  return {
    version: LOCAL_PLAY_SNAPSHOT_VERSION,
    teamName: state.teamName,
    runtimes: Object.fromEntries(
      [...state.runtimes].map(([problemId, runtime]) => [problemId, snapshotProgress(runtime)]),
    ),
    simulatedRuntimes: Object.fromEntries(
      [...state.simulatedRuntimes].map(([problemId, runtime]) => [
        problemId,
        {
          ...snapshotProgress(runtime),
          overrides: [...runtime.overrides],
          ...(runtime.createdAt ? { createdAt: runtime.createdAt } : {}),
          scoringState: runtime.scoringState,
          ...(runtime.endpointsHealth ? { endpointsHealth: runtime.endpointsHealth } : {}),
          ...(runtime.attackProbes ? { attackProbes: runtime.attackProbes } : {}),
          ...(runtime.posture ? { posture: runtime.posture } : {}),
          ...(runtime.platform ? { platform: runtime.platform } : {}),
          ...(runtime.lastResult ? { lastResult: runtime.lastResult } : {}),
        },
      ]),
    ),
    scoreEvents: [...state.scoreEvents],
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local-play snapshot ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Local-play snapshot ${field} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Local-play snapshot ${field} must be a string array`);
  }
  return value;
}

function entries<T>(
  value: unknown,
  field: string,
  parseValue: (entryValue: unknown, entryField: string) => T,
): readonly (readonly [string, T])[] {
  if (!Array.isArray(value)) throw new Error(`Local-play snapshot ${field} must be an array`);
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error(`Local-play snapshot ${field}[${index}] must be a key/value tuple`);
    }
    return [entry[0], parseValue(entry[1], `${field}[${index}][1]`)] as const;
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Local-play snapshot ${field} must be a string`);
  return value;
}

function parseProgress(value: unknown, field: string): ProblemProgressSnapshot {
  const progress = object(value, field);
  return {
    solved: stringArray(progress.solved, `${field}.solved`),
    revealedHints: entries(progress.revealedHints, `${field}.revealedHints`, (item, itemField) => {
      if (typeof item !== "string") {
        throw new Error(`Local-play snapshot ${itemField} must be a string`);
      }
      return item;
    }),
    wrongCounts: entries(progress.wrongCounts, `${field}.wrongCounts`, finiteNumber),
    score: finiteNumber(progress.score, `${field}.score`),
  };
}

function parseScoringState(value: unknown, field: string): SimulatedProblemRuntime["scoringState"] {
  const state = object(value, field);
  const serialized = JSON.stringify(state);
  const reparsed = JSON.parse(serialized) as SimulatedProblemRuntime["scoringState"];
  return reparsed;
}

function parseProgressRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, ProblemProgressSnapshot>> {
  return Object.fromEntries(
    Object.entries(object(value, field)).map(([problemId, progress]) => [
      problemId,
      parseProgress(progress, `${field}.${problemId}`),
    ]),
  );
}

function parseSimulatedProgressRecord(
  value: unknown,
): Readonly<Record<string, SimulatedProblemProgressSnapshot>> {
  return Object.fromEntries(
    Object.entries(object(value, "simulatedRuntimes")).map(([problemId, raw]) => {
      const field = `simulatedRuntimes.${problemId}`;
      const progress = object(raw, field);
      const lastResult = progress.lastResult;
      if (lastResult !== undefined && lastResult !== "ok" && lastResult !== "fail") {
        throw new Error(`Local-play snapshot ${field}.lastResult is invalid`);
      }
      return [
        problemId,
        {
          ...parseProgress(progress, field),
          overrides: entries(progress.overrides, `${field}.overrides`, (item, itemField) => {
            if (typeof item !== "string") {
              throw new Error(`Local-play snapshot ${itemField} must be a string`);
            }
            return item;
          }),
          scoringState: parseScoringState(progress.scoringState, `${field}.scoringState`),
          ...Object.fromEntries(
            ["createdAt", "endpointsHealth", "attackProbes", "posture", "platform"]
              .map((key) => [key, optionalString(progress[key], `${field}.${key}`)] as const)
              .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
          ),
          ...(lastResult ? { lastResult } : {}),
        },
      ];
    }),
  );
}

function parseScoreEvents(value: unknown): readonly LocalPlayScoreEvent[] {
  if (!Array.isArray(value)) throw new Error("Local-play snapshot scoreEvents must be an array");
  return value.map((raw, index) => {
    const event = object(raw, `scoreEvents[${index}]`);
    if (
      typeof event.jobId !== "string" ||
      typeof event.problemId !== "string" ||
      !["flag", "flag-wrong", "hint", "uptime", "attack-detected"].includes(String(event.source)) ||
      (event.result !== "ok" && event.result !== "wrong") ||
      typeof event.occurredAt !== "string"
    ) {
      throw new Error(`Local-play snapshot scoreEvents[${index}] is invalid`);
    }
    return {
      jobId: event.jobId,
      problemId: event.problemId,
      source: event.source as LocalPlayScoreEvent["source"],
      points: finiteNumber(event.points, `scoreEvents[${index}].points`),
      result: event.result,
      occurredAt: event.occurredAt,
    };
  });
}

export function parseLocalPlaySnapshot(serialized: string): LocalPlaySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Local-play snapshot is not valid JSON", { cause: error });
  }
  const snapshot = object(parsed, "root");
  if (snapshot.version !== LOCAL_PLAY_SNAPSHOT_VERSION) {
    throw new Error(`Local-play snapshot version ${String(snapshot.version)} is unsupported`);
  }
  if (typeof snapshot.teamName !== "string" || snapshot.teamName.length === 0) {
    throw new Error("Local-play snapshot teamName must be a non-empty string");
  }
  return {
    version: LOCAL_PLAY_SNAPSHOT_VERSION,
    teamName: snapshot.teamName,
    runtimes: parseProgressRecord(snapshot.runtimes, "runtimes"),
    simulatedRuntimes: parseSimulatedProgressRecord(snapshot.simulatedRuntimes),
    scoreEvents: parseScoreEvents(snapshot.scoreEvents),
  };
}

function restoreProgress(runtime: ProblemRuntime, progress: ProblemProgressSnapshot): void {
  runtime.solved.clear();
  for (const item of progress.solved) runtime.solved.add(item);
  runtime.revealedHints.clear();
  for (const [key, value] of progress.revealedHints) runtime.revealedHints.set(key, value);
  runtime.wrongCounts.clear();
  for (const [key, value] of progress.wrongCounts) runtime.wrongCounts.set(key, value);
  runtime.score = progress.score;
}

export function restoreLocalPlayState(state: LocalPlayState, snapshot: LocalPlaySnapshot): void {
  for (const problemId of Object.keys(snapshot.runtimes)) {
    if (!state.runtimes.has(problemId)) {
      throw new Error(`Local-play snapshot references unknown container problem ${problemId}`);
    }
  }
  for (const problemId of Object.keys(snapshot.simulatedRuntimes)) {
    if (!state.simulatedRuntimes.has(problemId)) {
      throw new Error(`Local-play snapshot references unknown simulated problem ${problemId}`);
    }
  }
  state.teamName = snapshot.teamName;
  for (const [problemId, progress] of Object.entries(snapshot.runtimes)) {
    const runtime = state.runtimes.get(problemId);
    if (runtime) restoreProgress(runtime, progress);
  }
  for (const [problemId, progress] of Object.entries(snapshot.simulatedRuntimes)) {
    const runtime = state.simulatedRuntimes.get(problemId);
    if (!runtime) continue;
    restoreProgress(runtime, progress);
    runtime.overrides.clear();
    for (const [key, value] of progress.overrides) runtime.overrides.set(key, value);
    runtime.createdAt = progress.createdAt;
    runtime.scoringState = progress.scoringState;
    runtime.endpointsHealth = progress.endpointsHealth;
    runtime.attackProbes = progress.attackProbes;
    runtime.posture = progress.posture;
    runtime.platform = progress.platform;
    runtime.lastResult = progress.lastResult;
    runtime.deployment = undefined;
  }
  state.scoreEvents.splice(0, state.scoreEvents.length, ...snapshot.scoreEvents);
}
