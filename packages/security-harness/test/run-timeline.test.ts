import { describe, expect, it } from "vitest";
import {
  projectTimelineForOrganizer,
  projectTimelineForParticipant,
  TimelineRecorder,
  toTimelineJson,
  toTimelineJsonl,
} from "../src/run-timeline.js";
import type { FindingEvidence, PatchEvaluation } from "../src/types.js";

const FINDING: FindingEvidence = {
  runId: "run-1",
  findingId: "run-1-finding-1",
  targetDigest: "sha256:baseline",
  threatModelDigest: "sha256:threat-model",
  focusArea: "documents-idor",
  witnessType: "http-sequence",
  witnessDigest: "sha256:witness",
  reproduction: { attempts: 2, successes: 2, freshEnvironment: true },
  verifier: { id: "v1", version: "1.0.0", policyDigest: "sha256:policy" },
  verdict: "confirmed",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const EVALUATION: PatchEvaluation = {
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
  reasons: ["everything held"],
  generatedAt: "2026-01-01T00:05:00.000Z",
};

function fixedClockSequence(times: readonly string[]): () => string {
  let i = 0;
  return () => {
    const t = times[Math.min(i, times.length - 1)];
    i += 1;
    return t;
  };
}

describe("TimelineRecorder", () => {
  it("should record events in insertion order with monotonically increasing sequence numbers", () => {
    const recorder = new TimelineRecorder("run-1", fixedClockSequence(["t0", "t1", "t2", "t3"]));
    recorder.recordStateTransition("QUEUED");
    recorder.recordFinding(FINDING);
    recorder.recordGoldenTests([{ id: "g1", description: "desc", passed: true }]);
    recorder.recordPatchEvaluation(EVALUATION);

    const events = recorder.toArray();
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.occurredAt)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(events.every((e) => e.runId === "run-1")).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "state-transition",
      "finding-recorded",
      "golden-tests-recorded",
      "patch-evaluation-recorded",
    ]);
  });

  it("should preserve stable order even when every event shares the exact same timestamp (fixed-clock test)", () => {
    const recorder = new TimelineRecorder("run-1", () => "2026-01-01T00:00:00.000Z");
    recorder.recordStateTransition("QUEUED");
    recorder.recordStateTransition("BUILDING");
    recorder.recordStateTransition("VERIFYING");
    expect(recorder.toArray().map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("toArray should return a snapshot, not a live view", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    recorder.recordStateTransition("QUEUED");
    const snapshot = recorder.toArray();
    recorder.recordStateTransition("BUILDING");
    expect(snapshot.length).toBe(1);
  });
});

describe("projectTimelineForParticipant: drops finding-recorded entirely", () => {
  it("should never emit a participant event derived from a finding-recorded entry", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    recorder.recordStateTransition("QUEUED");
    recorder.recordFinding(FINDING);
    recorder.recordPatchEvaluation(EVALUATION);

    const participantEvents = projectTimelineForParticipant(recorder.toArray());
    expect(participantEvents.some((e) => JSON.stringify(e).includes("documents-idor"))).toBe(false);
    expect(participantEvents.some((e) => JSON.stringify(e).includes("sha256:witness"))).toBe(false);
    expect(participantEvents.map((e) => e.type)).toEqual(["phase-update", "patch-result"]);
  });

  it("should map internal SecurityRunState values to the coarse public phase vocabulary", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    recorder.recordStateTransition("VALIDATING_PATCH");
    recorder.recordStateTransition("REATTACKING");
    recorder.recordStateTransition("INCONCLUSIVE");
    const events = projectTimelineForParticipant(recorder.toArray());
    expect(events.map((e) => (e.type === "phase-update" ? e.phase : undefined))).toEqual([
      "evaluating-patch",
      "evaluating-patch",
      "needs-more-information",
    ]);
  });

  it("should surface a golden-tests-recorded event as a participant golden-tests event", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    const goldenTests = [{ id: "g1", description: "normal login still works", passed: true }];
    recorder.recordGoldenTests(goldenTests);
    const events = projectTimelineForParticipant(recorder.toArray());
    expect(events).toEqual([{ sequence: 0, occurredAt: "t0", type: "golden-tests", goldenTests }]);
  });
});

describe("projectTimelineForOrganizer: full detail retained", () => {
  it("should keep the finding and full patch evaluation for an organizer audience", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    recorder.recordFinding(FINDING);
    recorder.recordPatchEvaluation(EVALUATION);
    const events = projectTimelineForOrganizer(recorder.toArray(), {
      participantCanSee: [],
      organizerCanSee: [
        "status",
        "verdict-reasons",
        "witness-digests",
        "target-patch-digests",
        "forbidden-side-effects",
        "verification-metadata",
        "golden-test-results",
        "generated-at",
      ],
    });
    const findingEvent = events.find((e) => e.type === "finding");
    expect(findingEvent && "finding" in findingEvent ? findingEvent.finding : undefined).toEqual(
      FINDING,
    );
    const patchEvent = events.find((e) => e.type === "patch-result");
    expect(
      patchEvent && patchEvent.type === "patch-result" ? patchEvent.evaluation.verdict : undefined,
    ).toBe("verified-fixed");
  });

  it("should keep the raw internal SecurityRunState on an organizer state-transition event, while the participant projection only ever sees the coarse phase", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    recorder.recordStateTransition("BUILDING");

    const organizerEvents = projectTimelineForOrganizer(recorder.toArray());
    expect(organizerEvents).toEqual([
      { sequence: 0, occurredAt: "t0", type: "state-transition", state: "BUILDING" },
    ]);

    const participantEvents = projectTimelineForParticipant(recorder.toArray());
    expect(participantEvents).toEqual([
      { sequence: 0, occurredAt: "t0", type: "phase-update", phase: "in-progress" },
    ]);
    // The organizer view names the raw internal state; the participant view must never leak it.
    expect(JSON.stringify(participantEvents)).not.toContain("BUILDING");
  });

  it("should surface a golden-tests-recorded event as an organizer golden-tests event", () => {
    const recorder = new TimelineRecorder("run-1", () => "t0");
    const goldenTests = [{ id: "g1", description: "normal login still works", passed: false }];
    recorder.recordGoldenTests(goldenTests);
    const events = projectTimelineForOrganizer(recorder.toArray());
    expect(events).toEqual([{ sequence: 0, occurredAt: "t0", type: "golden-tests", goldenTests }]);
  });
});

describe("JSON / JSONL export", () => {
  const events = [
    { sequence: 0, occurredAt: "t0", type: "phase-update", phase: "queued" },
    { sequence: 1, occurredAt: "t1", type: "phase-update", phase: "completed" },
  ];

  it("toTimelineJson should produce a parseable, order-preserving array", () => {
    const json = toTimelineJson(events);
    expect(JSON.parse(json)).toEqual(events);
  });

  it("toTimelineJsonl should produce exactly one JSON object per line with a trailing newline", () => {
    const jsonl = toTimelineJsonl(events);
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual(events);
  });

  it("toTimelineJsonl should return an empty string for an empty timeline, not a stray newline", () => {
    expect(toTimelineJsonl([])).toBe("");
  });
});
