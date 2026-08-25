/**
 * Participant / organizer spoiler boundary (Issue #3036 Phase 3): "participant には remediation
 * に必要な症状と結果だけを見せ、hidden exploit material を漏らさない。organizer には redacted
 * transcript / witness / verification / budget / failure reason を見せる。"
 *
 * This mirrors an existing, already-shipped non-spoiler invariant in this monorepo —
 * `infrastructure/lib/problem-deploy/handlers/shared/attack-probe-status.ts`'s comment: "snapshot
 * には probe の slot/path・脆弱性クラスを絶対に含めない。出せるのは問題側 metadata が明示した
 * label/symptom と outcome/penalty のみ" — applied to `PatchEvaluation` instead of
 * `AttackProbeStatus`. Same rule, same reasoning: raw witness content (HTTP method/path/headers/
 * body — literally the exploit request) and `focusArea` (already names the vulnerability class +
 * subsystem) never reach a participant-facing view, no matter what a `revealPolicy` says.
 *
 * Two independently-sufficient enforcement layers, deliberately redundant:
 *
 *  1. Type-level: `ParticipantPatchEvaluationView` / `ParticipantRunTimelineEvent` have no
 *     property that could ever hold a witness digest, a raw witness step, a free-text evaluator
 *     `reasons` entry, or a `forbiddenSideEffects` string. Those fields do not exist on the
 *     type, so no object-spread or "just pass the whole record through" shortcut can leak them —
 *     the compiler rejects it.
 *  2. Runtime: `sanitizeRevealPolicy` intersects whatever `participantCanSee` a problem author
 *     configures with `PARTICIPANT_ALLOWED_REVEAL_FIELDS`, a fixed, hand-audited ceiling defined
 *     ONLY in this file. A misconfigured or hostile `SecurityHarnessDefinition.revealPolicy` can
 *     narrow what a participant sees below this ceiling, but never widen it past it — fail closed,
 *     not fail open.
 */

import type {
  FindingEvidence,
  PatchEvaluation,
  PatchVerdict,
  RevealField,
  RevealPolicy,
} from "./types.js";

/**
 * The maximum a participant may EVER see, regardless of `SecurityHarnessDefinition.revealPolicy`.
 * Deliberately does not include: `verdict-reasons` (evaluator free text), `witness-digests`,
 * `target-patch-digests`, `forbidden-side-effects`, `budget-usage`, `verification-metadata`, or
 * `redacted-transcript-ref` — all organizer-only per the issue.
 */
export const PARTICIPANT_ALLOWED_REVEAL_FIELDS: ReadonlySet<RevealField> = new Set<RevealField>([
  "status",
  "bounded-claim-notice",
  "golden-test-results",
  "generated-at",
]);

/** Organizers may see everything the closed `RevealField` union declares. */
export const ORGANIZER_ALLOWED_REVEAL_FIELDS: ReadonlySet<RevealField> = new Set<RevealField>([
  "status",
  "bounded-claim-notice",
  "golden-test-results",
  "generated-at",
  "verdict-reasons",
  "witness-digests",
  "target-patch-digests",
  "forbidden-side-effects",
  "budget-usage",
  "verification-metadata",
  "redacted-transcript-ref",
]);

/**
 * Fail-closed default for a `SecurityHarnessDefinition` that omits `revealPolicy` entirely
 * (all Phase 1 definitions). Participants get only the bounded-claim notice and their own status
 * — not even golden test detail — until a problem author opts in explicitly; organizers get the
 * full ceiling.
 */
export const DEFAULT_REVEAL_POLICY: RevealPolicy = {
  participantCanSee: ["status", "bounded-claim-notice"],
  organizerCanSee: [...ORGANIZER_ALLOWED_REVEAL_FIELDS],
};

function intersect(
  requested: readonly RevealField[],
  ceiling: ReadonlySet<RevealField>,
): ReadonlySet<RevealField> {
  return new Set(requested.filter((f) => ceiling.has(f)));
}

/**
 * Clamps a (possibly attacker- or author-misconfigured) `RevealPolicy` to the fixed ceilings
 * above. Call this before using ANY revealPolicy value — never read
 * `definition.revealPolicy.participantCanSee` directly.
 */
export function sanitizeRevealPolicy(policy: RevealPolicy | undefined): {
  readonly participantCanSee: ReadonlySet<RevealField>;
  readonly organizerCanSee: ReadonlySet<RevealField>;
} {
  const effective = policy ?? DEFAULT_REVEAL_POLICY;
  return {
    participantCanSee: intersect(effective.participantCanSee, PARTICIPANT_ALLOWED_REVEAL_FIELDS),
    organizerCanSee: intersect(effective.organizerCanSee, ORGANIZER_ALLOWED_REVEAL_FIELDS),
  };
}

/** Structurally identical to `GoldenTestResult` in ./phase1-slice.ts, declared independently here to avoid a dependency edge from this generic module onto the Phase-1-specific slice. */
export interface PublicGoldenTestResult {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
}

/**
 * Participant-safe status vocabulary. Deliberately NOT `PatchVerdict` reused as-is: keeping a
 * separate type here means a future change to the internal `PatchVerdict` union (e.g. a new
 * infrastructure-failure case) cannot silently start flowing into the participant view just
 * because the two happened to share a type.
 */
export type ParticipantPatchStatus =
  | "fix-confirmed"
  | "exploit-still-reproducible"
  | "normal-function-broken"
  | "needs-more-information";

const VERDICT_TO_PARTICIPANT_STATUS: Readonly<Record<PatchVerdict, ParticipantPatchStatus>> = {
  "verified-fixed": "fix-confirmed",
  "still-vulnerable": "exploit-still-reproducible",
  regressed: "normal-function-broken",
  inconclusive: "needs-more-information",
};

/**
 * Fixed, hand-written, non-spoiler message per participant status. NEVER derived from
 * `PatchEvaluation.reasons` — that field is free-text evaluator output and is organizer-only by
 * design (see `PARTICIPANT_ALLOWED_REVEAL_FIELDS`).
 */
const PARTICIPANT_STATUS_MESSAGE: Readonly<Record<ParticipantPatchStatus, string>> = {
  "fix-confirmed":
    "Your patch blocked the reported behavior, declared normal functionality still passes, and an independent fresh re-attack within the declared budget found no new way to reproduce it.",
  "exploit-still-reproducible":
    "An independent verifier could still reproduce the reported behavior against your patch. Review the reported symptom and resubmit.",
  "normal-function-broken":
    "Your patch breaks declared normal functionality (see the golden test results below). Removing or disabling functionality is not accepted as a fix.",
  "needs-more-information":
    "The verifier could not reach a definitive result this run (for example the patch failed to build, or a verification step did not complete). This is neither a pass nor a fail — resubmit, or contact the organizer if it repeats.",
};

/**
 * Fixed disclaimer text (Issue #3036 "Bounded claim", ADR-0001 §1/§2). Every participant-facing
 * view that carries a `fix-confirmed`-adjacent status MUST show this — it is what stops a clean
 * result from being read as "this target has no other vulnerabilities".
 */
export const BOUNDED_CLAIM_NOTICE =
  "A clean result means no valid witness was found within the declared detector / focus area / budget / target digest — it is not proof that no vulnerabilities exist.";

export interface ParticipantPatchEvaluationView {
  readonly runId: string;
  readonly status: ParticipantPatchStatus;
  readonly message: string;
  readonly boundedClaimNotice?: string;
  readonly goldenTests?: readonly PublicGoldenTestResult[];
  readonly generatedAt?: string;
}

/**
 * The full detail an organizer is allowed to see. `baselineFinding` is passed through with its
 * `witnessDigest`/`focusArea` (organizer-only — never forwarded to a participant view), but never
 * a raw witness payload — Phase 1 has no captured raw witness bytes to leak in the first place
 * (see `FindingEvidence` in ./types.ts), and if/when Phase 2 adds one it must go through this same
 * file's ceiling, not around it. `redactedTranscriptRef` is an artifact-store reference (a digest,
 * from ./artifact-store.ts), never inline transcript content — the actual Finder transcript
 * artifact is Phase 2 scope.
 */
export interface OrganizerPatchEvaluationView {
  readonly runId: string;
  readonly status: ParticipantPatchStatus;
  readonly verdict?: PatchVerdict;
  readonly reasons?: readonly string[];
  readonly baselineFinding?: FindingEvidence;
  readonly baselineTargetDigest?: string;
  readonly patchDigest?: string;
  readonly digestsMatch?: boolean;
  readonly forbiddenSideEffects?: readonly string[];
  readonly goldenTests?: readonly PublicGoldenTestResult[];
  readonly originalWitnessReplay?: PatchEvaluation["originalWitnessReplay"];
  readonly freshReattack?: PatchEvaluation["freshReattack"];
  readonly generatedAt?: string;
  /** Digest reference into an artifact store (./artifact-store.ts), not inline content. */
  readonly redactedTranscriptRef?: string;
}

export interface PatchEvaluationProjectionInput {
  readonly evaluation: PatchEvaluation;
  readonly goldenTests?: readonly PublicGoldenTestResult[];
  readonly revealPolicy?: RevealPolicy;
  readonly redactedTranscriptRef?: string;
}

/**
 * Projects a `PatchEvaluation` down to what a PARTICIPANT may see. Fields are included only when
 * BOTH the (clamped) policy asks for them AND the returned type has a slot for them — the type
 * itself is the hard floor, the policy can only ask for less.
 */
export function projectPatchEvaluationForParticipant(
  input: PatchEvaluationProjectionInput,
): ParticipantPatchEvaluationView {
  const { participantCanSee } = sanitizeRevealPolicy(input.revealPolicy);
  const status = VERDICT_TO_PARTICIPANT_STATUS[input.evaluation.verdict];
  const view: {
    runId: string;
    status: ParticipantPatchStatus;
    message: string;
    boundedClaimNotice?: string;
    goldenTests?: readonly PublicGoldenTestResult[];
    generatedAt?: string;
  } = {
    runId: input.evaluation.runId,
    status,
    message: PARTICIPANT_STATUS_MESSAGE[status],
  };
  if (participantCanSee.has("bounded-claim-notice")) {
    view.boundedClaimNotice = BOUNDED_CLAIM_NOTICE;
  }
  if (participantCanSee.has("golden-test-results") && input.goldenTests !== undefined) {
    view.goldenTests = input.goldenTests;
  }
  if (participantCanSee.has("generated-at")) {
    view.generatedAt = input.evaluation.generatedAt;
  }
  return view;
}

/** Projects a `PatchEvaluation` down to what an ORGANIZER may see, per the (clamped) reveal policy. */
export function projectPatchEvaluationForOrganizer(
  input: PatchEvaluationProjectionInput,
): OrganizerPatchEvaluationView {
  const { organizerCanSee } = sanitizeRevealPolicy(input.revealPolicy);
  const status = VERDICT_TO_PARTICIPANT_STATUS[input.evaluation.verdict];
  const view: {
    runId: string;
    status: ParticipantPatchStatus;
    verdict?: PatchVerdict;
    reasons?: readonly string[];
    baselineFinding?: FindingEvidence;
    baselineTargetDigest?: string;
    patchDigest?: string;
    digestsMatch?: boolean;
    forbiddenSideEffects?: readonly string[];
    goldenTests?: readonly PublicGoldenTestResult[];
    originalWitnessReplay?: PatchEvaluation["originalWitnessReplay"];
    freshReattack?: PatchEvaluation["freshReattack"];
    generatedAt?: string;
    redactedTranscriptRef?: string;
  } = { runId: input.evaluation.runId, status };
  // "status" is always visible to organizers (it is the participant-safe collapse of `verdict`,
  // shown here too so operator UIs can render one badge component for both audiences).
  if (organizerCanSee.has("verdict-reasons")) {
    view.verdict = input.evaluation.verdict;
    view.reasons = input.evaluation.reasons;
  }
  if (organizerCanSee.has("witness-digests")) {
    view.baselineFinding = input.evaluation.baselineFinding;
  }
  if (organizerCanSee.has("target-patch-digests")) {
    view.baselineTargetDigest = input.evaluation.baselineTargetDigest;
    view.patchDigest = input.evaluation.patchDigest;
    view.digestsMatch = input.evaluation.digestsMatch;
  }
  if (organizerCanSee.has("forbidden-side-effects")) {
    view.forbiddenSideEffects = input.evaluation.forbiddenSideEffects;
  }
  if (organizerCanSee.has("golden-test-results") && input.goldenTests !== undefined) {
    view.goldenTests = input.goldenTests;
  }
  if (organizerCanSee.has("verification-metadata")) {
    view.originalWitnessReplay = input.evaluation.originalWitnessReplay;
    view.freshReattack = input.evaluation.freshReattack;
  }
  if (organizerCanSee.has("generated-at")) {
    view.generatedAt = input.evaluation.generatedAt;
  }
  if (organizerCanSee.has("redacted-transcript-ref") && input.redactedTranscriptRef !== undefined) {
    view.redactedTranscriptRef = input.redactedTranscriptRef;
  }
  return view;
}
