/**
 * Reference inter-team coordination plugin — "Cross-Account Capture".
 *
 * This is the canonical worked example a Battle problem ships to opt into the
 * platform's coordination host. It is a pure state machine, default-exported
 * through `defineCoordinationPlugin`, that the dispatcher Lambda drives (read the
 * shared event row → `dispatchOp` → optimistic write → `projectForTeam`). The
 * platform stays host-only; every rule below is owned by the problem.
 *
 * Scenario: teams race to plant a foothold in a fixed roster of contested
 * cross-account regions ("sectors"). Each sector is held by at most one team at a
 * time. A team claims a free sector, may release one it holds, and — once the
 * capture window closes (`tick`) — no new claims are accepted. `projectForTeam`
 * shows a team only its own holdings plus anonymous free/taken counts, never which
 * rival holds a given sector.
 *
 * The plugin is pure and deterministic: no clock (time arrives only via `tick`'s
 * `eventNowMs`), no network, no cloud SDK. Every branch is exercised in
 * `infrastructure/test/problem-pack/reference-coordination-battle-coordination.test.ts`.
 */
import { defineCoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";

/** The fixed roster of contested cross-account regions teams fight over. */
const SECTORS = ["us-east-1", "eu-west-1", "ap-northeast-1", "sa-east-1"] as const;

/** Milliseconds into the event after which the capture window closes. */
const CAPTURE_WINDOW_MS = 15 * 60 * 1000;

/** One event's shared board: who holds each sector, and whether captures are still open. */
export interface SectorControlState {
  /** sectorId → owning teamId, or `null` when the sector is free. */
  readonly holders: Readonly<Record<string, string | null>>;
  /** `"open"` while claims are accepted, `"locked"` once the capture window closes. */
  readonly phase: "open" | "locked";
}

/** A team's move: plant a foothold, or abandon one it holds. */
export type SectorControlOp =
  | { readonly type: "claim"; readonly sector: string }
  | { readonly type: "release"; readonly sector: string };

/** What one team is allowed to see: its own holdings plus anonymous board counts. */
export interface SectorControlProjection {
  readonly phase: "open" | "locked";
  readonly heldByMe: readonly string[];
  readonly free: number;
  readonly takenByOthers: number;
}

/** Build the opening board with every sector free. */
function freshHolders(): Record<string, string | null> {
  return Object.fromEntries(SECTORS.map((sector) => [sector, null]));
}

export default defineCoordinationPlugin<
  SectorControlState,
  SectorControlOp,
  SectorControlProjection
>({
  initialState: () => ({ holders: freshHolders(), phase: "open" }),

  validateOp: (state, teamId, op) => {
    if (!(op.sector in state.holders)) return { ok: false, error: "unknown_sector" };
    const holder = state.holders[op.sector];
    if (op.type === "claim") {
      if (state.phase === "locked") return { ok: false, error: "event_locked" };
      if (holder === teamId) return { ok: false, error: "already_yours" };
      if (holder !== null) return { ok: false, error: "sector_taken" };
      return { ok: true };
    }
    if (holder !== teamId) return { ok: false, error: "not_your_sector" };
    return { ok: true };
  },

  applyOp: (state, teamId, op) => ({
    ...state,
    holders: { ...state.holders, [op.sector]: op.type === "claim" ? teamId : null },
  }),

  tick: (state, eventNowMs) =>
    state.phase === "open" && eventNowMs >= CAPTURE_WINDOW_MS
      ? { ...state, phase: "locked" }
      : state,

  projectForTeam: (state, teamId) => {
    const entries = Object.entries(state.holders);
    return {
      phase: state.phase,
      heldByMe: entries.filter(([, holder]) => holder === teamId).map(([sector]) => sector),
      free: entries.filter(([, holder]) => holder === null).length,
      takenByOthers: entries.filter(([, holder]) => holder !== null && holder !== teamId).length,
    };
  },
});
