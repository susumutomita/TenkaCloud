import { chmodSync, existsSync, mkdirSync } from "node:fs";
import {
  type ContainerRunner,
  ContainerStartOwnershipError,
  type LocalComposeUnit,
  type RecoveredContainer,
  type StartedContainer,
} from "./container-runner";
import { createContainerRunner, isComposeUnitRunning, resolveComposeCli } from "./docker-adapter";
import type { ContainerProblem } from "./manifest";
import {
  createNativeCompatibilityGate,
  type NativeCompatibilityVerdict,
} from "./native-compatibility";
import { PORT_STRIDE } from "./port-remap";
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

export interface ReconcileRecordedContainerOptions {
  readonly problems: readonly ContainerProblem[];
  readonly units: Map<string, LocalComposeUnit>;
  readonly runner: Pick<ContainerRunner, "recover" | "stopPhysical" | "finalizeStop">;
  readonly isRunning: (unit: LocalComposeUnit) => boolean;
  readonly nativeCompatibility?: (problemId: string) => NativeCompatibilityVerdict;
  readonly persistUnits: () => void;
  readonly maxRunning: number;
}

interface LiveRecordedUnit {
  readonly problem: ContainerProblem;
  readonly unit: LocalComposeUnit;
}

function matchRecordedUnitsToCatalog(
  problems: readonly ContainerProblem[],
  units: Iterable<LocalComposeUnit>,
): { readonly matched: LiveRecordedUnit[]; readonly stale: LocalComposeUnit[] } {
  const catalog = new Map(problems.map((problem) => [problem.problemId, problem]));
  const matched: LiveRecordedUnit[] = [];
  const stale: LocalComposeUnit[] = [];
  for (const unit of units) {
    const problem = catalog.get(unit.problemId);
    const expectedProjectName = problem?.composeProjectName ?? `tc-local-${unit.problemId}`;
    if (unit.composeProjectName !== expectedProjectName) {
      // Never execute `compose down` for a project that has not been authenticated by
      // the current catalog; a corrupted ledger must not become authority over a foreign
      // project merely because it names a known problem id.
      throw new Error(`Recorded compose project does not match problem "${unit.problemId}"`);
    }
    if (problem) matched.push({ problem, unit });
    else stale.push(unit);
  }
  return { matched, stale };
}

function recoverableOffset(offset: number, maxRunning: number): boolean {
  return (
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset % PORT_STRIDE === 0 &&
    offset / PORT_STRIDE < maxRunning
  );
}

async function recoverLiveRecordedUnits(
  live: readonly LiveRecordedUnit[],
  runner: ReconcileRecordedContainerOptions["runner"],
  maxRunning: number,
): Promise<{
  readonly recovered: RecoveredContainer[];
  readonly stale: LocalComposeUnit[];
}> {
  const attempts = await Promise.all(
    live.map(async ({ problem, unit }) => {
      try {
        return { unit, recovered: await runner.recover(problem, unit) };
      } catch {
        return { unit };
      }
    }),
  );
  const offsetCounts = new Map<number, number>();
  for (const attempt of attempts) {
    if (!("recovered" in attempt) || !recoverableOffset(attempt.recovered.offset, maxRunning)) {
      continue;
    }
    const { offset } = attempt.recovered;
    offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
  }

  const recovered: RecoveredContainer[] = [];
  const stale: LocalComposeUnit[] = [];
  for (const attempt of attempts) {
    if (
      "recovered" in attempt &&
      recoverableOffset(attempt.recovered.offset, maxRunning) &&
      offsetCounts.get(attempt.recovered.offset) === 1
    ) {
      recovered.push(attempt.recovered);
    } else {
      stale.push(attempt.unit);
    }
  }
  return { recovered, stale };
}

async function inspectRecordedContainerUnits(
  options: ReconcileRecordedContainerOptions,
): Promise<{ readonly recovered: RecoveredContainer[]; readonly stale: LocalComposeUnit[] }> {
  const authenticated = matchRecordedUnitsToCatalog(options.problems, options.units.values());
  // Probe the complete durable allow-list before classifying or mutating any entry. A
  // daemon/CLI failure must abort the whole reconciliation without guessing that a unit
  // is stale and deleting its ownership record.
  const inspected = authenticated.matched.map(({ problem, unit }) => ({
    problem,
    unit,
    running: options.isRunning(unit),
  }));
  const live: LiveRecordedUnit[] = [];
  const stale: LocalComposeUnit[] = [...authenticated.stale];
  for (const { problem, unit, running } of inspected) {
    const compatible = options.nativeCompatibility?.(unit.problemId).supported ?? true;
    if (!running || !compatible) {
      stale.push(unit);
    } else {
      live.push({ problem, unit });
    }
  }

  // A running project can still be impossible to adopt after the catalog or its
  // generated compose changes, or when its endpoints never become ready. Treat that as
  // stale owned state and reclaim it; otherwise every control-plane replacement wedges
  // on the same bad ledger entry forever. Docker probe errors occur above and still abort
  // before this recovery/cleanup phase, so daemon uncertainty remains fail-closed.
  const attempted = await recoverLiveRecordedUnits(live, options.runner, options.maxRunning);
  return { recovered: attempted.recovered, stale: [...stale, ...attempted.stale] };
}

function cleanStaleRecordedUnits(
  stale: readonly LocalComposeUnit[],
  options: ReconcileRecordedContainerOptions,
): void {
  const cleanupErrors: unknown[] = [];
  for (const unit of stale) {
    try {
      stopPersistedContainerUnit(options.runner, options.units, options.persistUnits, unit);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Recorded container reconciliation failed");
  }
}

/**
 * [#3016] Join the durable ownership ledger with Docker's current state before the API
 * starts accepting requests. Only units already owned by this ledger may be adopted;
 * arbitrary `tc-local-*` projects remain foreign port conflicts under #2927.
 *
 * The whole live set is inspected and validated before cleanup or persistence changes, so
 * an unavailable Docker daemon or an ambiguous offset cannot partially rewrite ownership.
 */
export async function reconcileRecordedContainerUnits(
  options: ReconcileRecordedContainerOptions,
): Promise<RecoveredContainer[]> {
  if (!Number.isInteger(options.maxRunning) || options.maxRunning < 1) {
    throw new Error(`maxRunning must be a positive integer (got ${options.maxRunning})`);
  }
  const { recovered, stale } = await inspectRecordedContainerUnits(options);
  cleanStaleRecordedUnits(stale, options);

  // Persist the explicit offset on legacy units after every live unit has been validated.
  if (recovered.length > 0) {
    for (const container of recovered) {
      options.units.set(container.started.unit.problemId, container.started.unit);
    }
    options.persistUnits();
  }
  return recovered;
}

/** Container-side state and callbacks consumed by the long-lived local API. */
export interface ContainerServeRuntime {
  readonly units: Map<string, LocalComposeUnit>;
  readonly startContainer: (problem: ContainerProblem, offset: number) => Promise<StartedContainer>;
  readonly stopContainer: (unit: LocalComposeUnit) => void;
  readonly recoveredContainers: readonly RecoveredContainer[];
  readonly nativeCompatibility: (problemId: string) => NativeCompatibilityVerdict;
}

/**
 * Build one reconciled container runtime before the API opens ingress (#3016).
 * The same cached native gate is reused for adoption and later starts, and every start
 * acquires its durable compose handle before Docker can create the project.
 */
export async function prepareContainerServeRuntime(
  paths: LocalPaths,
  problems: readonly ContainerProblem[],
  maxRunning: number,
): Promise<ContainerServeRuntime> {
  const runner = createContainerRunner(paths.localDir);
  const catalog = new Map(problems.map((problem) => [problem.problemId, problem]));
  const nativeCompatibility = createNativeCompatibilityGate(
    (problemId) => catalog.get(problemId)?.compatibility,
  );
  const recorded = existsSync(paths.unitsPath)
    ? readRecordedUnits(paths.unitsPath, paths.localDir).units
    : [];
  const units = new Map(recorded.map((unit) => [unit.problemId, unit]));
  const persistUnits = (): void => {
    writePrivateJson(paths.unitsPath, { units: [...units.values()] } satisfies RecordedUnits);
  };
  const recoveredContainers = await reconcileRecordedContainerUnits({
    problems,
    units,
    runner,
    isRunning: isComposeUnitRunning,
    nativeCompatibility,
    persistUnits,
    maxRunning,
  });

  return {
    units,
    startContainer: async (problem, offset) => {
      try {
        return await runner.start(problem, offset, {
          acquire: (unit) => persistStartedContainerUnit(units, persistUnits, unit),
          cleanupFailedStart: (unit) =>
            stopPersistedContainerUnit(runner, units, persistUnits, unit),
        });
      } catch (error) {
        if (error instanceof ContainerStartOwnershipError) {
          units.set(error.unit.problemId, error.unit);
          try {
            persistUnits();
          } catch (persistError) {
            throw new ContainerStartOwnershipError(error.unit, [error, persistError]);
          }
        }
        throw error;
      }
    },
    stopContainer: (unit) => stopPersistedContainerUnit(runner, units, persistUnits, unit),
    recoveredContainers,
    nativeCompatibility,
  };
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
      const reason = lifecycle.lastError ? `: ${lifecycle.lastError}` : "";
      throw new Error(`problem "${problemId}" failed to start${reason}`);
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
    problems?: {
      name: string;
      stackOutputs: Record<string, string>;
      lifecycle?: { status?: string };
    }[];
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
