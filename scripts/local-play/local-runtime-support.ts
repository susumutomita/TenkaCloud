import { chmodSync, existsSync, mkdirSync } from "node:fs";
import {
  type ContainerRunner,
  ContainerStartOwnershipError,
  type LocalComposeUnit,
} from "./container-runner";
import { createContainerRunner, resolveComposeCli } from "./docker-adapter";
import { observeProcessIdentity } from "./process-identity";
import {
  type LocalPaths,
  type LocalProcessState,
  type RecordedUnits,
  readRecordedUnits,
  resolveLocalPaths,
  unlinkIfExists,
  writePrivateJson,
} from "./session-state";

/**
 * [#2632] Local-play runtime support layer, extracted from the `tenkacloud-local`
 * CLI so the entrypoint stays "command routing + composition only" (its stated
 * design). This module owns the low-level session/process/container helpers that
 * the `serve` process body and the `up` / `down` commands all share; it depends
 * only on the other `local-play/` adapters, never on the CLI, so there is no cycle.
 */
export const SERVE_SHUTDOWN_TIMEOUT_MS = 45_000;

export interface LocalServeShutdownDeps {
  readonly closeServer: () => Promise<void>;
  readonly scoringCycle?: Promise<void>;
  readonly persistState?: () => Promise<void>;
  /** [#2846] Kill every container shell before its container is torn down. */
  readonly closeTerminals?: () => void;
  readonly stopAll: () => Promise<void>;
  readonly closeSimulator: () => Promise<void>;
  readonly closeStateStore?: () => Promise<void>;
}

/** Quiesce ingress and scoring before either lifecycle owner mutates persisted state. */
export async function shutdownLocalServe(deps: LocalServeShutdownDeps): Promise<unknown[]> {
  const errors: unknown[] = [];
  const serverClosed = deps.closeServer().catch((error: unknown) => {
    errors.push(error);
  });
  const scoringSettled = (deps.scoringCycle ?? Promise.resolve()).catch((error: unknown) => {
    errors.push(error);
  });
  await Promise.all([serverClosed, scoringSettled]);
  try {
    await deps.persistState?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    // Shells die before the containers they are attached to; `closeAll` is idempotent,
    // so it does not matter that closing the server already reclaimed most of them.
    deps.closeTerminals?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await deps.stopAll();
  } catch (error) {
    errors.push(error);
  }
  try {
    await deps.closeSimulator();
  } catch (error) {
    errors.push(error);
  }
  try {
    await deps.closeStateStore?.();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

/** Release a Docker unit only after its durable ownership projection commits. */
export function stopPersistedContainerUnit(
  runner: Pick<ContainerRunner, "stopPhysical" | "finalizeStop">,
  units: Map<string, LocalComposeUnit>,
  persistUnits: () => void,
  unit: LocalComposeUnit,
): void {
  runner.stopPhysical(unit);
  units.delete(unit.problemId);
  try {
    persistUnits();
  } catch (error) {
    // The temp compose remains available, so portal Stop can safely retry the
    // idempotent compose down and the durable units projection.
    units.set(unit.problemId, unit);
    throw error;
  }
  try {
    runner.finalizeStop(unit);
  } catch (finalizeError) {
    units.set(unit.problemId, unit);
    try {
      persistUnits();
    } catch (recoveryError) {
      throw new AggregateError(
        [finalizeError, recoveryError],
        "Container stopped but its cleanup ownership could not be restored",
      );
    }
    throw finalizeError;
  }
}

/** Persist a newly-owned unit; on an ambiguous commit keep its compose handle for cleanup retry. */
export function persistStartedContainerUnit(
  units: Map<string, LocalComposeUnit>,
  persistUnits: () => void,
  unit: LocalComposeUnit,
): void {
  units.set(unit.problemId, unit);
  try {
    persistUnits();
  } catch (persistError) {
    try {
      // A write can throw after rename/directory fsync. Re-commit the full
      // ownership projection before returning so crash cleanup has the unit.
      persistUnits();
    } catch (recoveryError) {
      throw new ContainerStartOwnershipError(unit, [persistError, recoveryError]);
    }
    throw new ContainerStartOwnershipError(unit, [persistError]);
  }
}

export async function waitForServeProcessExit(
  pid: number,
  expectedIdentity: string | undefined,
  timeoutMs: number,
  observe: (processId: number) => string | undefined = observeProcessIdentity,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentIdentity = observe(pid);
    if (currentIdentity === undefined) return true;
    // The recorded process exited and the OS reused its numeric PID. Treat the
    // original as gone; never wait on or signal its replacement.
    if (expectedIdentity !== undefined && currentIdentity !== expectedIdentity) return true;
    await delay(50);
  }
  const currentIdentity = observe(pid);
  return (
    currentIdentity === undefined ||
    (expectedIdentity !== undefined && currentIdentity !== expectedIdentity)
  );
}

export function positivePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function requiredLocalApiPort(value: string | undefined): number {
  if (!value) {
    throw new Error("LOCAL_API_PORT is required for the detached local-play serve process");
  }
  return positivePort(value, 1, "LOCAL_API_PORT");
}

export function ensurePrivateLocalDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function privateLocalPaths(): LocalPaths {
  const paths = resolveLocalPaths();
  ensurePrivateLocalDirectory(paths.localDir);
  return paths;
}

export function assertDockerAvailable(): void {
  resolveComposeCli();
}

/**
 * Tear down every container recorded in `units.json` (idempotent compose down)
 * and drop the file. Used by `down`, by `up`'s failure cleanup, and by `up` to
 * reclaim leftovers from a crashed previous session before starting a new one.
 */
export function tearDownRecordedUnits(p: LocalPaths): void {
  if (!existsSync(p.unitsPath)) return;
  const runner = createContainerRunner(p.localDir);
  const recorded = readRecordedUnits(p.unitsPath, p.localDir).units;
  const units = new Map(recorded.map((unit) => [unit.problemId, unit]));
  const persistRemaining = (): void => {
    if (units.size > 0) {
      writePrivateJson(p.unitsPath, { units: [...units.values()] } satisfies RecordedUnits);
    } else {
      unlinkIfExists(p.unitsPath);
    }
  };
  const errors: unknown[] = [];
  for (const unit of recorded) {
    try {
      stopPersistedContainerUnit(runner, units, persistRemaining, unit);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Recorded container cleanup failed and can be retried");
  }
}

/** Pre-start one problem through the serve process's API (its lifecycle owns the container). */
export async function startProblemViaApi(
  apiBaseUrl: string,
  problemId: string,
  participantToken: string,
): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/start`,
    { method: "POST", headers: { authorization: `Bearer ${participantToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `failed to start problem "${problemId}" (HTTP ${response.status}): ${await response.text()}`,
    );
  }
}

interface ProblemLifecycle {
  readonly status?: string;
  readonly lastError?: string;
}

async function fetchProblemLifecycle(
  apiBaseUrl: string,
  problemId: string,
  participantToken: string,
): Promise<ProblemLifecycle | undefined> {
  const response = await fetch(`${apiBaseUrl}/portal/me`, {
    headers: { authorization: `Bearer ${participantToken}` },
  });
  if (!response.ok) {
    throw new Error(`failed to poll problem "${problemId}" (HTTP ${response.status})`);
  }
  const body = (await response.json()) as {
    problems?: { problemId: string; lifecycle?: ProblemLifecycle }[];
  };
  return body.problems?.find((problem) => problem.problemId === problemId)?.lifecycle;
}

/**
 * Container 問題の start は 202 (async) で返る — 初回はcompose の暗黙イメージ
 * ビルド (数分かかり得る) が走るため。 CLI の pre-start はブラウザと違い proxy に
 * 切られないが、 endpoints 表示や成功メッセージの前に terminal 状態まで待つ。
 * lifecycle.status が "running" になれば解決、 "error" なら lastError 込みで throw。
 */
export async function waitForProblemRunning(
  apiBaseUrl: string,
  problemId: string,
  participantToken: string,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const pollMs = options.pollMs ?? 2_000;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const lifecycle = await fetchProblemLifecycle(apiBaseUrl, problemId, participantToken);
    // lifecycle 不在 (= AWS mode 相当の view) は常時 playable 扱い → 待つ必要なし。
    if (!lifecycle || lifecycle.status === "running") return;
    if (lifecycle.status === "error") {
      throw new Error(
        `problem "${problemId}" failed to start${lifecycle.lastError ? `: ${lifecycle.lastError}` : ""}`,
      );
    }
    if (now() >= deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for problem "${problemId}" to start ` +
          "(the first start may build a heavy toolchain image — check the serve log)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Print the running problems' challenge endpoints as the API sees them (post-remap). */
function endpointDisplay(label: string, value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (/credential|accesskey/i.test(label)) return "[available in Participant Portal]";
  if (parsed.hash) parsed.hash = "";
  return parsed.toString();
}

export async function printRunningEndpoints(
  apiBaseUrl: string,
  participantToken: string,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/portal/me`, {
    headers: { authorization: `Bearer ${participantToken}` },
  });
  const body = (await response.json()) as {
    problems?: Array<{
      name: string;
      stackOutputs: Record<string, string>;
      lifecycle?: { status?: string };
    }>;
  };
  for (const problem of body.problems ?? []) {
    if (problem.lifecycle?.status !== "running") continue;
    for (const [label, url] of Object.entries(problem.stackOutputs)) {
      const display = endpointDisplay(label, url);
      if (display === undefined) continue;
      console.log(`Challenge — ${problem.name} (${label}): ${display}`);
    }
  }
}

/** Any HTTP answer from /healthz means the recorded API process is alive. */
async function apiIsHealthy(apiBaseUrl: string): Promise<boolean> {
  try {
    await fetch(`${apiBaseUrl}/healthz`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

export async function recordedApiIsHealthy(
  state: LocalProcessState,
  observe: (pid: number) => string | undefined = observeProcessIdentity,
  probe: (apiBaseUrl: string) => Promise<boolean> = apiIsHealthy,
): Promise<boolean> {
  if (observe(state.pid) !== state.processIdentity) return false;
  return probe(state.apiBaseUrl);
}
