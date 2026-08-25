/**
 * Run timeline + JSON/JSONL export (Issue #3036 Phase 3: "run timeline と JSON / JSONL export を
 * 追加する"), plus its own spoiler-boundary projection so exporting a timeline for a participant
 * audience cannot accidentally hand back the same object an organizer export would.
 *
 * `TimelineRecorder` is a small, synchronous, side-effect-free (except for pushing onto its own
 * private array) recorder that `phase1-slice.ts` drives with the SAME injected clock it already
 * uses for everything else — this file never reads `Date.now()` itself. Sequence numbers are
 * assigned by insertion order, not by timestamp, so a recorder fed a clock that returns the same
 * value for every call (as fixed-clock tests do) still produces a total, stable order.
 *
 * "現行 attackProbes projection と共存する" (Issue #3036 / #2422): this module does not read,
 * write, or depend on `AttackProbeStatus` / `scoring.attackProbes`
 * (`infrastructure/lib/problem-deploy/handlers/shared/attack-probe-status.ts`) in any way. A
 * Battle problem with no `SecurityHarnessDefinition` keeps using attack probes exactly as before;
 * a problem that adopts this harness gets an ADDITIONAL, independent timeline. Nothing here
 * replaces `AttackProbeStatus`'s wire shape or its non-spoiler invariant — it is the same
 * invariant, reimplemented for a different data shape (see ./reveal-policy.ts's header comment).
 */

import {
  type OrganizerPatchEvaluationView,
  type ParticipantPatchEvaluationView,
  type PublicGoldenTestResult,
  projectPatchEvaluationForOrganizer,
  projectPatchEvaluationForParticipant,
} from "./reveal-policy.js";
import type { FindingEvidence, PatchEvaluation, RevealPolicy, SecurityRunState } from "./types.js";

export type SecurityRunTimelineEventType =
  | "state-transition"
  | "finding-recorded"
  | "golden-tests-recorded"
  | "patch-evaluation-recorded";

interface BaseTimelineEvent {
  readonly runId: string;
  /** Insertion order, 0-based. Stable even when `occurredAt` ties (a fixed-clock test run). */
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface StateTransitionTimelineEvent extends BaseTimelineEvent {
  readonly type: "state-transition";
  readonly state: SecurityRunState;
}

export interface FindingRecordedTimelineEvent extends BaseTimelineEvent {
  readonly type: "finding-recorded";
  readonly finding: FindingEvidence;
}

export interface GoldenTestsRecordedTimelineEvent extends BaseTimelineEvent {
  readonly type: "golden-tests-recorded";
  readonly goldenTests: readonly PublicGoldenTestResult[];
}

export interface PatchEvaluationRecordedTimelineEvent extends BaseTimelineEvent {
  readonly type: "patch-evaluation-recorded";
  readonly patchEvaluation: PatchEvaluation;
}

/**
 * The organizer-grade, unredacted internal timeline. NEVER hand this to a participant surface —
 * it carries `FindingEvidence` (witness digest, focus area) and full `PatchEvaluation` (raw
 * `reasons`, `forbiddenSideEffects`). Use `projectTimelineForParticipant` first.
 */
export type SecurityRunTimelineEvent =
  | StateTransitionTimelineEvent
  | FindingRecordedTimelineEvent
  | GoldenTestsRecordedTimelineEvent
  | PatchEvaluationRecordedTimelineEvent;

/**
 * The type-specific payload for one timeline event, before the shared `runId`/`sequence`/
 * `occurredAt` bookkeeping fields are attached. Declared as its own explicit union (NOT
 * `Omit<SecurityRunTimelineEvent, ...>`) because `Omit` over a discriminated union collapses to
 * the members' COMMON keys only (`keyof (A | B)` is an intersection, not a union, of each
 * member's keys) — it would silently accept only `{ type }` and reject every event's own payload
 * field, which is exactly the bug this explicit union avoids.
 */
type TimelineEventInit =
  | { readonly type: "state-transition"; readonly state: SecurityRunState }
  | { readonly type: "finding-recorded"; readonly finding: FindingEvidence }
  | {
      readonly type: "golden-tests-recorded";
      readonly goldenTests: readonly PublicGoldenTestResult[];
    }
  | { readonly type: "patch-evaluation-recorded"; readonly patchEvaluation: PatchEvaluation };

/** Records timeline events in insertion order using one injected clock. Pure bookkeeping — no I/O, no network, no filesystem. */
export class TimelineRecorder {
  private readonly events: SecurityRunTimelineEvent[] = [];

  constructor(
    private readonly runId: string,
    private readonly now: () => string,
  ) {}

  private push(event: TimelineEventInit): void {
    this.events.push({
      ...event,
      runId: this.runId,
      sequence: this.events.length,
      occurredAt: this.now(),
    });
  }

  recordStateTransition(state: SecurityRunState): void {
    this.push({ type: "state-transition", state });
  }

  recordFinding(finding: FindingEvidence): void {
    this.push({ type: "finding-recorded", finding });
  }

  recordGoldenTests(goldenTests: readonly PublicGoldenTestResult[]): void {
    this.push({ type: "golden-tests-recorded", goldenTests });
  }

  recordPatchEvaluation(patchEvaluation: PatchEvaluation): void {
    this.push({ type: "patch-evaluation-recorded", patchEvaluation });
  }

  toArray(): readonly SecurityRunTimelineEvent[] {
    return [...this.events];
  }
}

/** Coarse, non-spoiler run phase a participant may see in place of the raw `SecurityRunState`. */
export type ParticipantRunPhase =
  | "queued"
  | "in-progress"
  | "awaiting-remediation"
  | "evaluating-patch"
  | "completed"
  | "cancelled"
  | "failed"
  | "needs-more-information";

const STATE_TO_PARTICIPANT_PHASE: Readonly<Record<SecurityRunState, ParticipantRunPhase>> = {
  QUEUED: "queued",
  BUILDING: "in-progress",
  RECONNING: "in-progress",
  FINDING: "in-progress",
  VERIFYING: "in-progress",
  DEDUPING: "in-progress",
  READY_FOR_REMEDIATION: "awaiting-remediation",
  VALIDATING_PATCH: "evaluating-patch",
  REATTACKING: "evaluating-patch",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  INCONCLUSIVE: "needs-more-information",
};

export type ParticipantTimelineEvent =
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "phase-update";
      readonly phase: ParticipantRunPhase;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "golden-tests";
      readonly goldenTests: readonly PublicGoldenTestResult[];
    }
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "patch-result";
      readonly evaluation: ParticipantPatchEvaluationView;
    };

export type OrganizerTimelineEvent =
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "state-transition";
      readonly state: SecurityRunState;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "finding";
      readonly finding: FindingEvidence;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "golden-tests";
      readonly goldenTests: readonly PublicGoldenTestResult[];
    }
  | {
      readonly sequence: number;
      readonly occurredAt: string;
      readonly type: "patch-result";
      readonly evaluation: OrganizerPatchEvaluationView;
    };

/**
 * Projects the internal timeline for a PARTICIPANT audience. `finding-recorded` events are
 * dropped entirely — the pre-patch `FindingEvidence` (focus area, witness digest) is exactly the
 * hidden exploit material the issue says a participant must never see; participants only ever see
 * the SYMPTOM (supplied by problem metadata outside this package) and the RESULT of their own
 * patch attempt.
 */
export function projectTimelineForParticipant(
  events: readonly SecurityRunTimelineEvent[],
  revealPolicy?: RevealPolicy,
  redactedTranscriptRef?: string,
): readonly ParticipantTimelineEvent[] {
  const out: ParticipantTimelineEvent[] = [];
  for (const event of events) {
    if (event.type === "state-transition") {
      out.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "phase-update",
        phase: STATE_TO_PARTICIPANT_PHASE[event.state],
      });
    } else if (event.type === "golden-tests-recorded") {
      out.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "golden-tests",
        goldenTests: event.goldenTests,
      });
    } else if (event.type === "patch-evaluation-recorded") {
      out.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "patch-result",
        evaluation: projectPatchEvaluationForParticipant({
          evaluation: event.patchEvaluation,
          revealPolicy,
          redactedTranscriptRef,
        }),
      });
    }
    // "finding-recorded" intentionally has no participant branch — dropped, not merely hidden.
  }
  return out;
}

/** Projects the internal timeline for an ORGANIZER audience, still routed through the (clamped) reveal policy. */
export function projectTimelineForOrganizer(
  events: readonly SecurityRunTimelineEvent[],
  revealPolicy?: RevealPolicy,
  redactedTranscriptRef?: string,
): readonly OrganizerTimelineEvent[] {
  return events.map((event): OrganizerTimelineEvent => {
    if (event.type === "state-transition") {
      return {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "state-transition",
        state: event.state,
      };
    }
    if (event.type === "finding-recorded") {
      return {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "finding",
        finding: event.finding,
      };
    }
    if (event.type === "golden-tests-recorded") {
      return {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: "golden-tests",
        goldenTests: event.goldenTests,
      };
    }
    return {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: "patch-result",
      evaluation: projectPatchEvaluationForOrganizer({
        evaluation: event.patchEvaluation,
        revealPolicy,
        redactedTranscriptRef,
      }),
    };
  });
}

/** Canonical pretty JSON export — one array, two-space indent, stable key order (whatever the object literal declares). */
export function toTimelineJson(events: readonly unknown[]): string {
  return JSON.stringify(events, null, 2);
}

/** JSON Lines export: one compact JSON object per line, trailing newline, no wrapping array — the format the issue's "JSON / JSONL export" names for streaming/append-friendly consumption. */
export function toTimelineJsonl(events: readonly unknown[]): string {
  if (events.length === 0) return "";
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}
