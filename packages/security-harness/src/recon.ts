/**
 * Recon: threat-model-driven focus-area partitioning (Issue #3036 Phase 2 "threat model に基づく
 * Recon と focus-area partition"). Pure and deterministic — the same threat model and finder count
 * always produce the same assignment; nothing here reads the clock or `Math.random()`.
 *
 * This is the actual work behind the `RECONNING` state `run-state-machine.ts` already reserves
 * (see that file's doc comment on the `BUILDING -> RECONNING` edge) — `planRecon` does not change
 * the state machine itself, it fills in what happens while a run sits in that state.
 *
 * Reference-implementation property this preserves (ADR-0001 §"Recon が attack surface を分割し、
 * 複数 Finder の同一箇所への収束を減らす"): each focus area is attributed to at most one PRIMARY
 * finder before any focus area is covered twice, so independent Finders are pointed at different
 * attack surface first. Only once every focus area already has a primary finder does a spare
 * finder slot get assigned a SECOND finder on an already-covered area (round-robin, for redundant
 * coverage `./dedupe.ts` can then collapse) — see `planRecon`'s doc comment for exactly when that
 * happens and why it is not the default.
 */

export interface ThreatModelFocusArea {
  readonly id: string;
  /**
   * Organizer-authored, reviewed-before-the-run free text. This is NOT model output and is not
   * subject to the Finder handoff schema restriction in `./finder-output.ts` — that restriction
   * exists because Finder output is untrusted model text, which this is not.
   */
  readonly description: string;
  /** Relative priority — higher covered first when finders are scarcer than focus areas. Ties break by declaration order (stable), so the plan never depends on object property enumeration order or any non-deterministic sort behavior. */
  readonly priority: number;
}

export interface ReconThreatModel {
  readonly threatModelDigest: string;
  readonly focusAreas: readonly ThreatModelFocusArea[];
}

export interface ReconFinderAssignment {
  readonly finderIndex: number;
  readonly focusArea: string;
}

export interface ReconPlan {
  readonly threatModelDigest: string;
  readonly maxFinders: number;
  readonly assignments: readonly ReconFinderAssignment[];
  /**
   * Focus areas declared in the threat model that got NO finder this run, because `maxFinders`
   * was smaller than the number of declared focus areas. Never silently dropped: a run report
   * that omitted this would misrepresent what was actually searched, which is exactly the
   * "Bounded claim" the issue requires ("指定 detector / focus area / budget / target digest の
   * 範囲で有効な witness が確認されなかった" — a focus area that was never assigned a finder was
   * never searched at all, which is a stronger statement than "no witness found").
   */
  readonly uncoveredFocusAreaIds: readonly string[];
}

function stableSortByPriorityDesc(
  focusAreas: readonly ThreatModelFocusArea[],
): readonly ThreatModelFocusArea[] {
  return focusAreas
    .map((focusArea, declarationIndex) => ({ focusArea, declarationIndex }))
    .sort((a, b) => {
      if (b.focusArea.priority !== a.focusArea.priority) {
        return b.focusArea.priority - a.focusArea.priority;
      }
      return a.declarationIndex - b.declarationIndex;
    })
    .map((entry) => entry.focusArea);
}

/**
 * Highest-priority-first assignment of focus areas to finder slots, with stable tie-breaking by
 * declaration order.
 *
 * - If `maxFinders >= focusAreas.length`: every focus area gets exactly one PRIMARY finder, and
 *   any leftover finder slots are handed a SECOND (redundant) pass over the highest-priority focus
 *   areas, round-robin, so no finder sits idle and `./dedupe.ts` has independent-Finder duplicates
 *   to actually collapse. `uncoveredFocusAreaIds` is empty in this case.
 * - If `maxFinders < focusAreas.length`: the highest-priority `maxFinders` areas each get one
 *   PRIMARY finder; the rest are reported in `uncoveredFocusAreaIds`, never merged into another
 *   finder's assignment — one Finder cannot be attributed to two focus areas at once without
 *   breaking `focusArea` provenance all the way down to `FindingEvidence.focusArea`.
 * - `maxFinders <= 0` or an empty `focusAreas` list both produce zero assignments; the boundary
 *   case for "no finders declared" and "no focus areas declared" collapse to the same "nothing to
 *   run" result rather than needing separate handling downstream.
 */
export function planRecon(threatModel: ReconThreatModel, maxFinders: number): ReconPlan {
  const base: Omit<ReconPlan, "assignments" | "uncoveredFocusAreaIds"> = {
    threatModelDigest: threatModel.threatModelDigest,
    maxFinders,
  };

  if (maxFinders <= 0 || threatModel.focusAreas.length === 0) {
    return {
      ...base,
      assignments: [],
      uncoveredFocusAreaIds: maxFinders <= 0 ? threatModel.focusAreas.map((f) => f.id) : [],
    };
  }

  const ordered = stableSortByPriorityDesc(threatModel.focusAreas);
  const primaryCount = Math.min(maxFinders, ordered.length);
  const primaries = ordered.slice(0, primaryCount);
  const uncovered = ordered.slice(primaryCount);

  const assignments: ReconFinderAssignment[] = primaries.map((focusArea, finderIndex) => ({
    finderIndex,
    focusArea: focusArea.id,
  }));

  // Spare finder slots (only possible when every focus area already has a primary finder, i.e.
  // uncovered is empty) get a second, round-robin pass over the highest-priority areas.
  const spareSlots = maxFinders - primaryCount;
  for (let i = 0; i < spareSlots; i += 1) {
    const focusArea = ordered[i % ordered.length];
    if (focusArea === undefined) continue;
    assignments.push({ finderIndex: primaryCount + i, focusArea: focusArea.id });
  }

  return {
    ...base,
    assignments,
    uncoveredFocusAreaIds: uncovered.map((f) => f.id),
  };
}
