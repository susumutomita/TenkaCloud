import type {
  HostPlugin,
  LocalMatch,
} from "../../../../../scripts/local-host/coordination-core.js";
import type { EventRecord } from "./events.js";

export const NATIVE_COORDINATION_PROBLEM = "ac26-crypto-battle";
export const COORDINATION_CHUNK_BYTES = 256 * 1024;
export const COORDINATION_MAX_BYTES = 2 * 1024 * 1024;

export interface NativeCoordinationArtifact {
  readonly problemId: string;
  readonly artifactDigest: string;
  readonly pluginKey: string;
  readonly catalogKey: string;
  readonly stateBudget: { readonly bytesPerTeam: number; readonly baseBytes: number };
  readonly plugin: HostPlugin;
}
export interface NativeCoordinationRun {
  readonly eventId: string;
  readonly problemId: string;
  readonly runId: string;
  readonly revision: number;
  readonly artifactDigest: string;
  readonly pluginKey: string;
  readonly catalogKey: string;
  readonly roster: readonly { readonly teamId: string; readonly teamName: string }[];
  /** Server-only. HTTP handlers may return only the plugin's team projection. */
  readonly match: LocalMatch;
  readonly clock: {
    readonly pausedMs: number;
    readonly lockedAt?: number;
    readonly elapsedMs: number;
  };
  readonly closed: boolean;
  readonly updatedAt: string;
}
export interface NativeCoordinationResponse {
  readonly status: 200 | 422;
  readonly body: { readonly projection?: unknown; readonly error?: string };
  readonly revision: number;
}
export interface NativeSchedulePatch {
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly scoringLocked?: boolean;
  readonly scoreboardFreezeMinutes?: number;
  readonly status?: Extract<EventRecord["status"], "ENDED" | "TEARDOWN">;
}
export class NativeCoordinationError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 422 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "NativeCoordinationError";
  }
}
export function coordinationHeadKey(eventId: string, problemId: string) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(eventId) || problemId !== NATIVE_COORDINATION_PROBLEM)
    throw new Error("Invalid native coordination scope.");
  return { PK: `COORD#${eventId}#${problemId}`, SK: "HEAD" };
}
