import { describe, expect, it } from "vitest";
import {
  BOUNDED_CLAIM_NOTICE,
  DEFAULT_REVEAL_POLICY,
  ORGANIZER_ALLOWED_REVEAL_FIELDS,
  PARTICIPANT_ALLOWED_REVEAL_FIELDS,
  projectPatchEvaluationForOrganizer,
  projectPatchEvaluationForParticipant,
  sanitizeRevealPolicy,
} from "../src/reveal-policy.js";
import type { FindingEvidence, PatchEvaluation, RevealPolicy } from "../src/types.js";

const FINDING: FindingEvidence = {
  runId: "run-1",
  findingId: "run-1-finding-1",
  targetDigest: "sha256:baseline",
  threatModelDigest: "sha256:threat-model",
  focusArea: "documents-idor",
  witnessType: "http-sequence",
  witnessDigest: "sha256:witness-secret-shape",
  reproduction: { attempts: 2, successes: 2, freshEnvironment: true },
  verifier: { id: "v1", version: "1.0.0", policyDigest: "sha256:policy" },
  verdict: "confirmed",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function evaluation(overrides: Partial<PatchEvaluation> = {}): PatchEvaluation {
  return {
    runId: "run-1",
    baselineTargetDigest: "sha256:baseline",
    patchDigest: "sha256:patch",
    baselineFinding: FINDING,
    build: "passed",
    goldenBehavior: "passed",
    originalWitnessReplay: "blocked",
    freshReattack: "no-witness-found",
    forbiddenSideEffects: [],
    digestsMatch: true,
    verdict: "verified-fixed",
    reasons: [
      "build passed, golden behavior held, the original witness is blocked, and a fresh re-attack found no witness within budget",
    ],
    generatedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

const GOLDEN_TESTS = [
  { id: "own-doc-a", description: "User A can fetch their own document", passed: true },
];

/**
 * The exact key set a participant view may ever contain. Any additional key — in particular
 * `reasons`, `baselineFinding`, `forbiddenSideEffects`, `witnessDigest`, `focusArea`, or raw
 * witness content — is exactly the "hidden exploit material" the issue forbids leaking. This list
 * is the detector: widen `ParticipantPatchEvaluationView`'s runtime shape (e.g. a future
 * maintainer accidentally spreads the full `PatchEvaluation` into the view) and this test fails.
 */
const PARTICIPANT_KEY_ALLOWLIST = new Set([
  "runId",
  "status",
  "message",
  "boundedClaimNotice",
  "goldenTests",
  "generatedAt",
]);

describe("sanitizeRevealPolicy: fail-closed ceiling", () => {
  it("should clamp participantCanSee to the participant ceiling even when a definition asks for organizer-only fields", () => {
    const hostile: RevealPolicy = {
      participantCanSee: [
        "status",
        "verdict-reasons",
        "witness-digests",
        "forbidden-side-effects",
        "redacted-transcript-ref",
      ],
      organizerCanSee: [],
    };
    const { participantCanSee } = sanitizeRevealPolicy(hostile);
    for (const field of participantCanSee) {
      expect(PARTICIPANT_ALLOWED_REVEAL_FIELDS.has(field)).toBe(true);
    }
    expect(participantCanSee.has("verdict-reasons")).toBe(false);
    expect(participantCanSee.has("witness-digests")).toBe(false);
    expect(participantCanSee.has("forbidden-side-effects")).toBe(false);
    expect(participantCanSee.has("redacted-transcript-ref")).toBe(false);
    expect(participantCanSee.has("status")).toBe(true);
  });

  it("should apply a fail-closed default (status + bounded-claim-notice only) when no policy is configured", () => {
    const { participantCanSee } = sanitizeRevealPolicy(undefined);
    expect([...participantCanSee].sort()).toEqual(
      [...DEFAULT_REVEAL_POLICY.participantCanSee].sort(),
    );
    expect(participantCanSee.has("golden-test-results")).toBe(false);
  });

  it("should let organizerCanSee use the full organizer ceiling", () => {
    const policy: RevealPolicy = {
      participantCanSee: [],
      organizerCanSee: [...ORGANIZER_ALLOWED_REVEAL_FIELDS],
    };
    const { organizerCanSee } = sanitizeRevealPolicy(policy);
    expect(organizerCanSee).toEqual(ORGANIZER_ALLOWED_REVEAL_FIELDS);
  });
});

describe("projectPatchEvaluationForParticipant: spoiler boundary", () => {
  const wideOpenPolicy: RevealPolicy = {
    // Deliberately asks for everything, including organizer-only fields, to prove the ceiling —
    // not the caller's policy — is what actually gates the participant view.
    participantCanSee: [...ORGANIZER_ALLOWED_REVEAL_FIELDS],
    organizerCanSee: [],
  };

  it("should never expose a key outside the participant allowlist, even under a wide-open policy", () => {
    const view = projectPatchEvaluationForParticipant({
      evaluation: evaluation(),
      goldenTests: GOLDEN_TESTS,
      revealPolicy: wideOpenPolicy,
    });
    for (const key of Object.keys(view)) {
      expect(PARTICIPANT_KEY_ALLOWLIST.has(key)).toBe(true);
    }
  });

  it("should never carry the baseline finding, witness digest, focus area, raw reasons, or forbidden side effects", () => {
    const view = projectPatchEvaluationForParticipant({
      evaluation: evaluation(),
      goldenTests: GOLDEN_TESTS,
      revealPolicy: wideOpenPolicy,
    }) as unknown as Record<string, unknown>;
    expect(view.baselineFinding).toBeUndefined();
    expect(view.reasons).toBeUndefined();
    expect(view.forbiddenSideEffects).toBeUndefined();
    expect(view.witnessDigest).toBeUndefined();
    expect(view.focusArea).toBeUndefined();
    expect(view.baselineTargetDigest).toBeUndefined();
    expect(view.patchDigest).toBeUndefined();
    expect(view.verdict).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("documents-idor");
    expect(JSON.stringify(view)).not.toContain("sha256:witness-secret-shape");
  });

  it("should map every PatchVerdict to a distinct, fixed, non-empty participant message", () => {
    const cases: [PatchEvaluation["verdict"], string][] = [
      ["verified-fixed", "fix-confirmed"],
      ["still-vulnerable", "exploit-still-reproducible"],
      ["regressed", "normal-function-broken"],
      ["inconclusive", "needs-more-information"],
    ];
    for (const [verdict, status] of cases) {
      const view = projectPatchEvaluationForParticipant({ evaluation: evaluation({ verdict }) });
      expect(view.status).toBe(status);
      expect(view.message.length).toBeGreaterThan(0);
    }
  });

  it("should only include goldenTests when the (clamped) policy allows it", () => {
    const withoutGolden = projectPatchEvaluationForParticipant({
      evaluation: evaluation(),
      goldenTests: GOLDEN_TESTS,
      revealPolicy: { participantCanSee: ["status"], organizerCanSee: [] },
    });
    expect(withoutGolden.goldenTests).toBeUndefined();

    const withGolden = projectPatchEvaluationForParticipant({
      evaluation: evaluation(),
      goldenTests: GOLDEN_TESTS,
      revealPolicy: { participantCanSee: ["status", "golden-test-results"], organizerCanSee: [] },
    });
    expect(withGolden.goldenTests).toEqual(GOLDEN_TESTS);
  });

  it("should always be able to show the fixed bounded-claim notice text when the policy allows it, verbatim", () => {
    const view = projectPatchEvaluationForParticipant({
      evaluation: evaluation(),
      revealPolicy: { participantCanSee: ["status", "bounded-claim-notice"], organizerCanSee: [] },
    });
    expect(view.boundedClaimNotice).toBe(BOUNDED_CLAIM_NOTICE);
  });
});

describe("projectPatchEvaluationForOrganizer: full detail, still policy-gated", () => {
  it("should include verdict/reasons/witness/digests/side-effects when the policy allows them", () => {
    const view = projectPatchEvaluationForOrganizer({
      evaluation: evaluation(),
      goldenTests: GOLDEN_TESTS,
      revealPolicy: DEFAULT_REVEAL_POLICY,
      redactedTranscriptRef: "sha256:transcript-ref",
    });
    expect(view.verdict).toBe("verified-fixed");
    expect(view.reasons).toEqual(evaluation().reasons);
    expect(view.baselineFinding).toEqual(FINDING);
    expect(view.baselineTargetDigest).toBe("sha256:baseline");
    expect(view.patchDigest).toBe("sha256:patch");
    expect(view.forbiddenSideEffects).toEqual([]);
    expect(view.goldenTests).toEqual(GOLDEN_TESTS);
    expect(view.originalWitnessReplay).toBe("blocked");
    expect(view.freshReattack).toBe("no-witness-found");
    expect(view.redactedTranscriptRef).toBe("sha256:transcript-ref");
  });

  it("should omit organizer-only fields the policy does not grant", () => {
    const view = projectPatchEvaluationForOrganizer({
      evaluation: evaluation(),
      revealPolicy: { participantCanSee: [], organizerCanSee: ["status"] },
    });
    expect(view.verdict).toBeUndefined();
    expect(view.reasons).toBeUndefined();
    expect(view.baselineFinding).toBeUndefined();
    expect(view.forbiddenSideEffects).toBeUndefined();
  });
});
