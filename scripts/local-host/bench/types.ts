/** Shared record shapes for the local-host capacity benchmark (`bun run bench:host`). */

export interface MachineInfo {
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  readonly bunVersion: string;
  readonly platform: string;
}

export interface LatencyStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** One simulated minute of Mode `state`, for one team count. */
export interface StateMinuteRecord {
  readonly minute: number;
  readonly stateBytes: number;
  readonly dbBytes: number;
  readonly walBytes: number;
  readonly projection: LatencyStats;
  readonly op: LatencyStats;
  /** Teams whose projection latency fed `projection` this minute (see state-sim.ts). */
  readonly sampledTeams: number;
  readonly leakOps: number;
  readonly rejectedOps: number;
  readonly errors: number;
  readonly matchRemainingMs: number | null;
  readonly phase: string | null;
}

export interface StateRunResult {
  readonly teams: number;
  readonly minutes: readonly StateMinuteRecord[];
  readonly finalStateBytes: number;
  readonly finalDbBytes: number;
  readonly finalWalBytes: number;
  readonly totalLeakOps: number;
  readonly totalRejectedOps: number;
  readonly totalErrors: number;
  readonly wallClockMs: number;
  readonly stoppedReason: "match-ended" | "minute-cap" | "safety-cap";
}

/** One ramp step of Mode `http`, for a fixed number of virtual tabs. */
export interface HttpStepRecord {
  readonly tabs: number;
  readonly seconds: number;
  readonly requestsSent: number;
  readonly nonOkCount: number;
  readonly networkErrorCount: number;
  readonly droppedTicks: number;
  readonly errorRate: number;
  readonly overall: LatencyStats;
  readonly projection: LatencyStats;
  readonly cpuPercent: { readonly avg: number; readonly max: number };
  readonly rssBytes: { readonly avg: number; readonly max: number };
  readonly sqliteBytesAdded: number;
}

export interface HttpRunResult {
  readonly teams: number;
  readonly steps: readonly HttpStepRecord[];
  readonly stoppedEarly: { readonly atTabs: number; readonly reason: string } | null;
}

export interface BenchReport {
  readonly machine: MachineInfo;
  readonly generatedAt: string;
  readonly mode: "state" | "http";
  readonly config: Record<string, unknown>;
  readonly state?: readonly StateRunResult[];
  readonly http?: HttpRunResult;
}
