/**
 * The Phase 1 deterministic vertical slice (Issue #3036): wires the pure contracts in this
 * package — the run state machine, the http-sequence witness executor, the finding verdict, and
 * the patch verdict — around a real, in-process, intentionally-vulnerable HTTP target and three
 * patch variants (one correct fix, two named "fake fix" patterns from the issue).
 *
 * Why this counts as "actually working" AND deterministic at the same time: every target is a
 * real `node:http` server handling real requests over a real loopback socket — nothing here is
 * mocked — but the servers, the witnesses, and the object ids involved are all fixed content, so
 * the same call always produces the same verdict. The only externally-injectable seams are the
 * clock (`now`) and a cooperative cancellation check (`shouldCancel`), both defaulted for the demo
 * CLI (`bin/run-phase1-demo.ts`) and overridden by tests that need determinism or to prove
 * cancellation stops the run before further work happens.
 *
 * Repository boundary: the fixtures under ./fixtures are a throwaway conformance target for this
 * package's own contracts, not the Challenge catalog's "first intentionally vulnerable Web
 * target" (that is out-of-scope follow-up work in `TenkaCloudChallenge` — see ./fixtures/shared.ts).
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sha256Hex, toDigestRef } from "./digest.js";
import { evaluateFindingVerdict } from "./evaluate-finding.js";
import { evaluatePatch } from "./evaluate-patch.js";
import {
  createServer as createPatchedCorrectServer,
  DIGEST as PATCHED_CORRECT_DIGEST,
} from "./fixtures/patched-correct.js";
import {
  createServer as createPatchedDenylistServer,
  DIGEST as PATCHED_DENYLIST_DIGEST,
} from "./fixtures/patched-denylist-only.js";
import {
  createServer as createPatchedEndpointRemovedServer,
  DIGEST as PATCHED_ENDPOINT_REMOVED_DIGEST,
} from "./fixtures/patched-endpoint-removed.js";
import {
  createServer as createVulnerableServer,
  DIGEST as VULNERABLE_DIGEST,
} from "./fixtures/vulnerable.js";
import { transitionSecurityRun } from "./run-state-machine.js";
import type {
  FindingEvidence,
  HttpSequenceWitness,
  PatchEvaluation,
  SecurityRunState,
} from "./types.js";
import { type HttpClient, runHttpSequenceWitness } from "./witness.js";

export type TargetVariant =
  | "vulnerable"
  | "patched-correct"
  | "patched-denylist-only"
  | "patched-endpoint-removed";

interface FixtureModule {
  readonly createServer: () => Server;
  readonly DIGEST: string;
}

// Named imports (not `import * as`) so each fixture's `createServer`/`DIGEST` is referenced
// explicitly here, rather than only reachable through this record's runtime-keyed lookup —
// dead-code analysis over a `Record<TargetVariant, …>` indexed by a runtime string cannot see
// which member of each entry ends up called.
const MODULES: Readonly<Record<TargetVariant, FixtureModule>> = {
  vulnerable: { createServer: createVulnerableServer, DIGEST: VULNERABLE_DIGEST },
  "patched-correct": { createServer: createPatchedCorrectServer, DIGEST: PATCHED_CORRECT_DIGEST },
  "patched-denylist-only": {
    createServer: createPatchedDenylistServer,
    DIGEST: PATCHED_DENYLIST_DIGEST,
  },
  "patched-endpoint-removed": {
    createServer: createPatchedEndpointRemovedServer,
    DIGEST: PATCHED_ENDPOINT_REMOVED_DIGEST,
  },
};

interface LaunchedTarget {
  readonly baseUrl: string;
  readonly digest: string;
  close(): Promise<void>;
}

async function launchTarget(variant: TargetVariant): Promise<LaunchedTarget> {
  const mod = MODULES[variant];
  const server = mod.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    digest: mod.DIGEST,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function makeHttpClient(baseUrl: string): HttpClient {
  return {
    async request(step) {
      const response = await fetch(`${baseUrl}${step.path}`, {
        method: step.method,
        headers: step.headers,
        body: step.body,
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

/** The canonical, hidden-from-participants witness this whole slice is about: user A reading user B's `doc-b1`. */
const ORIGINAL_WITNESS: HttpSequenceWitness = {
  type: "http-sequence",
  witnessId: "idor-doc-b1",
  focusArea: "documents-idor",
  steps: [
    {
      method: "GET",
      path: "/documents/doc-b1",
      headers: { authorization: "token-a" },
      expectStatus: 200,
      expectBodyIncludes: "Bob private note B1",
    },
  ],
};

/**
 * A DIFFERENT witness — different object id, never seen by the original report — used only for
 * the post-patch fresh re-attack. This is what catches a patch that denylists only the exact id
 * the original witness used (Issue #3036's named fake-fix pattern).
 */
const FRESH_REATTACK_WITNESS: HttpSequenceWitness = {
  type: "http-sequence",
  witnessId: "idor-doc-b2-fresh",
  focusArea: "documents-idor",
  steps: [
    {
      method: "GET",
      path: "/documents/doc-b2",
      headers: { authorization: "token-a" },
      expectStatus: 200,
      expectBodyIncludes: "Bob private note B2",
    },
  ],
};

/** Declared normal functionality, expressed the same way as an exploit witness: success means the behavior holds. */
const GOLDEN_TESTS: readonly {
  readonly id: string;
  readonly description: string;
  readonly witness: HttpSequenceWitness;
}[] = [
  {
    id: "own-doc-a",
    description: "User A can fetch their own document",
    witness: {
      type: "http-sequence",
      witnessId: "golden-own-doc-a",
      focusArea: "documents-golden",
      steps: [
        {
          method: "GET",
          path: "/documents/doc-a1",
          headers: { authorization: "token-a" },
          expectStatus: 200,
          expectBodyIncludes: "Alice private note A1",
        },
      ],
    },
  },
  {
    id: "own-doc-b",
    description: "User B can fetch their own document",
    witness: {
      type: "http-sequence",
      witnessId: "golden-own-doc-b",
      focusArea: "documents-golden",
      steps: [
        {
          method: "GET",
          path: "/documents/doc-b1",
          headers: { authorization: "token-b" },
          expectStatus: 200,
          expectBodyIncludes: "Bob private note B1",
        },
      ],
    },
  },
  {
    id: "create-and-list",
    description: "Creating a document makes it appear in the caller's own list",
    witness: {
      type: "http-sequence",
      witnessId: "golden-create-and-list",
      focusArea: "documents-golden",
      steps: [
        {
          method: "POST",
          path: "/documents",
          headers: { authorization: "token-a", "content-type": "application/json" },
          body: JSON.stringify({ content: "golden note" }),
          expectStatus: 201,
        },
        {
          method: "GET",
          path: "/documents/mine",
          headers: { authorization: "token-a" },
          expectStatus: 200,
          expectBodyIncludes: "golden note",
        },
      ],
    },
  },
];

export interface Phase1SliceOptions {
  readonly runId: string;
  /** Normally "vulnerable" — pass a patched variant to exercise the "baseline not reproducible -> INCONCLUSIVE" path. */
  readonly baselineVariant: TargetVariant;
  readonly patchVariant: TargetVariant;
  readonly minimumReproductions?: number;
  readonly reproductionAttempts?: number;
  readonly now?: () => string;
  /** Checked before each stage. Returning true stops the run at CANCELLED before that stage's work runs. */
  readonly shouldCancel?: () => boolean;
}

export interface GoldenTestResult {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
}

export interface Phase1SliceResult {
  readonly runId: string;
  readonly states: readonly SecurityRunState[];
  readonly finalState: SecurityRunState;
  readonly finding?: FindingEvidence;
  readonly goldenTests?: readonly GoldenTestResult[];
  readonly patchEvaluation?: PatchEvaluation;
}

interface VerifyBaselineParams {
  readonly runId: string;
  readonly targetDigest: string;
  readonly threatModelDigest: string;
  readonly reproductionAttempts: number;
  readonly minimumReproductions: number;
  readonly now: () => string;
  readonly client: HttpClient;
}

/** Runs the canonical witness `reproductionAttempts` times against a fresh baseline target and produces the one `FindingEvidence` Phase 1 needs. */
async function verifyBaseline(params: VerifyBaselineParams): Promise<FindingEvidence> {
  let successes = 0;
  for (let attempt = 0; attempt < params.reproductionAttempts; attempt += 1) {
    const run = await runHttpSequenceWitness(ORIGINAL_WITNESS, params.client);
    if (run.success) successes += 1;
  }
  const verdict = evaluateFindingVerdict({
    targetDigestMatches: true,
    threatModelDigestMatches: true,
    attempts: params.reproductionAttempts,
    successes,
    minimumReproductions: params.minimumReproductions,
    freshEnvironment: true,
    sandboxFailure: false,
  });
  return {
    runId: params.runId,
    findingId: `${params.runId}-finding-1`,
    targetDigest: params.targetDigest,
    threatModelDigest: params.threatModelDigest,
    focusArea: ORIGINAL_WITNESS.focusArea,
    witnessType: "http-sequence",
    witnessDigest: toDigestRef(sha256Hex(JSON.stringify(ORIGINAL_WITNESS))),
    reproduction: { attempts: params.reproductionAttempts, successes, freshEnvironment: true },
    verifier: {
      id: "phase1-deterministic-verifier",
      version: "1.0.0",
      policyDigest: toDigestRef(sha256Hex("phase1-policy-v1")),
    },
    verdict,
    generatedAt: params.now(),
  };
}

interface GoldenAndReplayResult {
  readonly goldenTests: readonly GoldenTestResult[];
  readonly goldenBehavior: "passed" | "failed";
  readonly originalWitnessReplay: "blocked" | "landed";
}

/** Runs the declared normal-functionality checks and replays the original witness against a patched target. */
async function runGoldenTestsAndOriginalReplay(client: HttpClient): Promise<GoldenAndReplayResult> {
  const goldenRuns = await Promise.all(
    GOLDEN_TESTS.map((t) => runHttpSequenceWitness(t.witness, client)),
  );
  const goldenTests: readonly GoldenTestResult[] = GOLDEN_TESTS.map((t, i) => ({
    id: t.id,
    description: t.description,
    passed: goldenRuns[i].success,
  }));
  const originalReplay = await runHttpSequenceWitness(ORIGINAL_WITNESS, client);
  return {
    goldenTests,
    goldenBehavior: goldenTests.every((t) => t.passed) ? "passed" : "failed",
    originalWitnessReplay: originalReplay.success ? "landed" : "blocked",
  };
}

/** Runs a fresh re-attack witness (a different object id than the original report) against a patched target. */
async function runFreshReattack(
  client: HttpClient,
): Promise<"no-witness-found" | "witness-confirmed"> {
  const reattack = await runHttpSequenceWitness(FRESH_REATTACK_WITNESS, client);
  return reattack.success ? "witness-confirmed" : "no-witness-found";
}

export async function runPhase1Slice(options: Phase1SliceOptions): Promise<Phase1SliceResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const shouldCancel = options.shouldCancel ?? ((): boolean => false);
  const minimumReproductions = options.minimumReproductions ?? 2;
  const reproductionAttempts = options.reproductionAttempts ?? minimumReproductions;
  const threatModelDigest = toDigestRef(sha256Hex("idor-documents-focus-area-v1"));

  const states: SecurityRunState[] = ["QUEUED"];
  let state: SecurityRunState = "QUEUED";
  const moveTo = (next: SecurityRunState): void => {
    state = transitionSecurityRun(state, next);
    states.push(state);
  };
  const cancelled = (): boolean => {
    if (!shouldCancel()) return false;
    moveTo("CANCELLED");
    return true;
  };
  const finish = (
    finding?: FindingEvidence,
    goldenTests?: readonly GoldenTestResult[],
    patchEvaluation?: PatchEvaluation,
  ): Phase1SliceResult => ({
    runId: options.runId,
    states: [...states],
    finalState: state,
    ...(finding !== undefined ? { finding } : {}),
    ...(goldenTests !== undefined ? { goldenTests } : {}),
    ...(patchEvaluation !== undefined ? { patchEvaluation } : {}),
  });

  if (cancelled()) return finish();
  moveTo("BUILDING");

  const baseline = await launchTarget(options.baselineVariant);
  try {
    if (cancelled()) return finish();
    // Phase 1 has no autonomous Recon/Find loop, so evidence moves straight from BUILDING to
    // VERIFYING (see ./run-state-machine.ts's doc comment on this edge).
    moveTo("VERIFYING");

    const finding = await verifyBaseline({
      runId: options.runId,
      targetDigest: baseline.digest,
      threatModelDigest,
      reproductionAttempts,
      minimumReproductions,
      now,
      client: makeHttpClient(baseline.baseUrl),
    });

    // Exactly one finding in Phase 1, so dedupe is a pass-through — the state still exists so
    // Phase 2's multi-Finder dedupe logic slots into the same machine without a reshape.
    moveTo("DEDUPING");
    if (cancelled()) return finish(finding);

    if (finding.verdict !== "confirmed") {
      // Baseline first (Issue #3036): a run whose baseline could not be independently confirmed
      // is neither a participant success nor failure.
      moveTo("INCONCLUSIVE");
      return finish(finding);
    }

    moveTo("READY_FOR_REMEDIATION");
    if (cancelled()) return finish(finding);

    moveTo("VALIDATING_PATCH");
    const patch = await launchTarget(options.patchVariant);
    try {
      const patchClient = makeHttpClient(patch.baseUrl);
      const { goldenTests, goldenBehavior, originalWitnessReplay } =
        await runGoldenTestsAndOriginalReplay(patchClient);

      if (cancelled()) return finish(finding, goldenTests);
      moveTo("REATTACKING");
      const freshReattack = await runFreshReattack(patchClient);

      const patchEvaluation = evaluatePatch({
        runId: options.runId,
        baselineTargetDigest: baseline.digest,
        patchDigest: patch.digest,
        baselineFinding: finding,
        build: "passed",
        goldenBehavior,
        originalWitnessReplay,
        freshReattack,
        forbiddenSideEffects: [],
        digestsMatch: baseline.digest === finding.targetDigest,
      });

      moveTo("COMPLETED");
      return finish(finding, goldenTests, patchEvaluation);
    } finally {
      await patch.close();
    }
  } finally {
    await baseline.close();
  }
}
