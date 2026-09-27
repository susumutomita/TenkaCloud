import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompetitionEngine } from "../competition-engine";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { fileBytesOrZero } from "./process-metrics";
import {
  apiRequest,
  type CreatedEvent,
  type CreatedTeam,
  HOST_KEY,
  PROBLEM_ID,
  setupMatch,
} from "./state-setup";
import { LatencyRecorder } from "./stats";
import type { StateMinuteRecord, StateRunResult } from "./types";

const STEP_MS = 5_000;
const STEPS_PER_MINUTE = 60_000 / STEP_MS;
/** Runaway-loop guard: real matches run ~90 minutes, this is over twice that. */
const SAFETY_CAP_MINUTES = 200;

export interface StateRunOptions {
  readonly repositoryRoot: string;
  readonly teamCounts: readonly number[];
  readonly sampleTeams: number;
  /** Caps the simulated match at this many minutes even if it has not ended (`--quick`). */
  readonly maxMinutes: number | null;
  readonly log: (message: string) => void;
}

interface Contract {
  readonly id: string;
  readonly allowedMethods: readonly string[];
}
interface Projection {
  readonly matchRemainingMs?: number;
  readonly phase?: string;
  readonly myContracts?: readonly Contract[];
}
interface StepCounters {
  leakOps: number;
  rejectedOps: number;
  errors: number;
}

/** One team's projection read. Every team is read every step to find LEAK targets — that
 * matches one real browser tab per team polling every 5s; only sampled teams' latency is kept. */
async function readTeamProjection(
  service: HostingService,
  team: CreatedTeam,
  sampleIds: ReadonlySet<string>,
  projectionLatency: LatencyRecorder,
  counters: StepCounters,
  log: (message: string) => void,
): Promise<Projection | null> {
  const start = performance.now();
  try {
    const response = await service.participant(
      apiRequest({
        method: "GET",
        path: "/portal/me/coordination/projection",
        token: team.teamLoginKey,
      }),
    );
    if (response.status >= 300) throw new Error(`status ${String(response.status)}`);
    if (sampleIds.has(team.teamId)) projectionLatency.push(performance.now() - start);
    const body = response.body as { projection?: Projection };
    return body.projection ?? null;
  } catch (error) {
    counters.errors += 1;
    log(`projection read failed for ${team.teamId}: ${String(error)}`);
    return null;
  }
}

/** LEAKs every open Order this team has not already leaked; a repeat is never attempted. */
async function leakOpenContracts(
  service: HostingService,
  team: CreatedTeam,
  projection: Projection,
  already: Set<string>,
  opLatency: LatencyRecorder,
  counters: StepCounters,
  log: (message: string) => void,
): Promise<void> {
  const targets = (projection.myContracts ?? []).filter(
    (contract) => contract.allowedMethods.includes("leak") && !already.has(contract.id),
  );
  for (const contract of targets) {
    const start = performance.now();
    try {
      const response = await service.participant(
        apiRequest({
          method: "POST",
          path: "/portal/me/coordination/op",
          token: team.teamLoginKey,
          body: { op: { kind: "leak", contractId: contract.id } },
        }),
      );
      opLatency.push(performance.now() - start);
      counters.leakOps += 1;
      if (response.status === 422) counters.rejectedOps += 1;
      else if (response.status >= 300) counters.errors += 1;
    } catch (error) {
      counters.errors += 1;
      log(`leak op failed for ${team.teamId}/${contract.id}: ${String(error)}`);
    }
    already.add(contract.id);
  }
}

/** Every team's projection (needed to find LEAK targets) plus every leak op, this step. */
async function stepOnce(
  service: HostingService,
  teams: readonly CreatedTeam[],
  sampleIds: ReadonlySet<string>,
  leaked: Map<string, Set<string>>,
  projectionLatency: LatencyRecorder,
  opLatency: LatencyRecorder,
  counters: StepCounters,
  log: (message: string) => void,
): Promise<Projection | null> {
  let latest: Projection | null = null;
  for (const team of teams) {
    const projection = await readTeamProjection(
      service,
      team,
      sampleIds,
      projectionLatency,
      counters,
      log,
    );
    if (!projection) continue;
    latest = projection;
    const already = leaked.get(team.teamId) ?? new Set<string>();
    await leakOpenContracts(service, team, projection, already, opLatency, counters, log);
    leaked.set(team.teamId, already);
  }
  return latest;
}

interface WindowState {
  readonly minutes: StateMinuteRecord[];
  readonly totals: StepCounters;
  readonly windowCounters: StepCounters;
}

/** Folds the current minute's window into `state.minutes`/`state.totals` and resets it. */
function flushMinute(
  minute: number,
  latest: Projection | null,
  store: HostStore,
  eventId: string,
  databasePath: string,
  projectionLatency: LatencyRecorder,
  opLatency: LatencyRecorder,
  sampledTeams: number,
  state: WindowState,
): void {
  state.minutes.push({
    minute,
    stateBytes: Buffer.byteLength(store.coordination(eventId, PROBLEM_ID) ?? ""),
    dbBytes: fileBytesOrZero(databasePath),
    walBytes: fileBytesOrZero(`${databasePath}-wal`),
    projection: projectionLatency.summarize(),
    op: opLatency.summarize(),
    sampledTeams,
    leakOps: state.windowCounters.leakOps,
    rejectedOps: state.windowCounters.rejectedOps,
    errors: state.windowCounters.errors,
    matchRemainingMs: latest?.matchRemainingMs ?? null,
    phase: latest?.phase ?? null,
  });
  state.totals.leakOps += state.windowCounters.leakOps;
  state.totals.rejectedOps += state.windowCounters.rejectedOps;
  state.totals.errors += state.windowCounters.errors;
  state.windowCounters.leakOps = 0;
  state.windowCounters.rejectedOps = 0;
  state.windowCounters.errors = 0;
  projectionLatency.reset();
  opLatency.reset();
}

function decideStop(
  latest: Projection | null,
  minute: number,
  maxMinutes: number | null,
): StateRunResult["stoppedReason"] | null {
  const remainingMs = latest?.matchRemainingMs;
  const phase = latest?.phase;
  if (phase === "ended" || (remainingMs !== undefined && remainingMs <= 0)) return "match-ended";
  if (maxMinutes !== null && minute >= maxMinutes) return "minute-cap";
  if (minute >= SAFETY_CAP_MINUTES) return "safety-cap";
  return null;
}

interface MatchLoopResult {
  readonly minutes: readonly StateMinuteRecord[];
  readonly totals: StepCounters;
  readonly stoppedReason: StateRunResult["stoppedReason"];
}

async function simulateMatch(
  service: HostingService,
  store: HostStore,
  databasePath: string,
  created: CreatedEvent,
  options: StateRunOptions,
  teamCount: number,
  advanceClock: () => void,
): Promise<MatchLoopResult> {
  const sampleIds = new Set(
    created.teams
      .slice(0, Math.min(options.sampleTeams, created.teams.length))
      .map((team) => team.teamId),
  );
  const leaked = new Map<string, Set<string>>(
    created.teams.map((team) => [team.teamId, new Set<string>()]),
  );
  const projectionLatency = new LatencyRecorder();
  const opLatency = new LatencyRecorder();
  const state: WindowState = {
    minutes: [],
    totals: { leakOps: 0, rejectedOps: 0, errors: 0 },
    windowCounters: { leakOps: 0, rejectedOps: 0, errors: 0 },
  };
  let stepIndex = 0;
  for (;;) {
    const latest = await stepOnce(
      service,
      created.teams,
      sampleIds,
      leaked,
      projectionLatency,
      opLatency,
      state.windowCounters,
      options.log,
    );
    stepIndex += 1;
    if (stepIndex % STEPS_PER_MINUTE === 0) {
      const minute = stepIndex / STEPS_PER_MINUTE;
      flushMinute(
        minute,
        latest,
        store,
        created.eventId,
        databasePath,
        projectionLatency,
        opLatency,
        sampleIds.size,
        state,
      );
      options.log(
        `state ${String(teamCount)} teams: minute ${String(minute)}, ` +
          `remaining=${String(latest?.matchRemainingMs ?? "unknown")}ms, phase=${String(latest?.phase ?? "unknown")}`,
      );
      const stop = decideStop(latest, minute, options.maxMinutes);
      if (stop) return { minutes: state.minutes, totals: state.totals, stoppedReason: stop };
    }
    advanceClock();
  }
}

async function runOneStateCase(
  teamCount: number,
  options: StateRunOptions,
): Promise<StateRunResult> {
  const started = Date.now();
  const dataDirectory = mkdtempSync(join(tmpdir(), "tenka-bench-state-"));
  const databasePath = join(dataDirectory, "host.sqlite");
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const store = new HostStore(new Database(databasePath));
  const service = new HostingService(
    store,
    new CompetitionEngine(options.repositoryRoot, dataDirectory),
    HOST_KEY,
    () => clock,
  );
  try {
    const created = await setupMatch(service, teamCount);
    clock += STEP_MS;
    const { minutes, totals, stoppedReason } = await simulateMatch(
      service,
      store,
      databasePath,
      created,
      options,
      teamCount,
      () => {
        clock += STEP_MS;
      },
    );
    const lastMinute = minutes[minutes.length - 1];
    return {
      teams: teamCount,
      minutes,
      finalStateBytes: lastMinute?.stateBytes ?? 0,
      finalDbBytes: lastMinute?.dbBytes ?? fileBytesOrZero(databasePath),
      finalWalBytes: lastMinute?.walBytes ?? fileBytesOrZero(`${databasePath}-wal`),
      totalLeakOps: totals.leakOps,
      totalRejectedOps: totals.rejectedOps,
      totalErrors: totals.errors,
      wallClockMs: Date.now() - started,
      stoppedReason,
    };
  } finally {
    store.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

export async function runStateMode(options: StateRunOptions): Promise<StateRunResult[]> {
  const results: StateRunResult[] = [];
  for (const teamCount of options.teamCounts) {
    options.log(`state mode: starting ${String(teamCount)} teams`);
    results.push(await runOneStateCase(teamCount, options));
  }
  return results;
}
