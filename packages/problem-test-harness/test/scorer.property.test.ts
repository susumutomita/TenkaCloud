/**
 * Property-based invariants for the deterministic offline scorer.
 *
 * fast-check reports the seed and replay path for every counterexample, so any
 * generated failure can be reproduced without pinning one global seed.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runScorer, type ScoreInput } from "../src/scorer.js";
import type { FakeProbeResult, ProblemScoringMetadata } from "../src/scoring-types.js";

const PROPERTY_PARAMETERS = { numRuns: 1_000 } as const;
const TOKEN_CHARACTERS = [..."abcdefghijklmnopqrstuvwxyz0123456789"];
const UNRELATED_OUTPUT_KEY = "Unrelated_Output_Key";
const UNRELATED_PROBE_URL = "https://unrelated.example.invalid/";

const tokenArbitrary = fc
  .array(fc.constantFrom(...TOKEN_CHARACTERS), { minLength: 1, maxLength: 12 })
  .map((characters) => characters.join(""));
const outputKeyArbitrary = tokenArbitrary.map((token) => `Output_${token}`);
const nonEmptyOutputArbitrary = tokenArbitrary.map((token) => `value-${token}`);
const urlArbitrary = tokenArbitrary.map((token) => `https://${token}.example.test/`);
const statusArbitrary = fc.integer({ min: 100, max: 599 });
const expectedStatusesArbitrary = fc.uniqueArray(statusArbitrary, {
  minLength: 1,
  maxLength: 5,
});
const outputValueArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constant(""),
  nonEmptyOutputArbitrary,
);
const probeResultArbitrary: fc.Arbitrary<FakeProbeResult> = fc.record({
  reachable: fc.boolean(),
  status: fc.option(statusArbitrary, { nil: undefined }),
});
const optionalProbeResultArbitrary = fc.option(probeResultArbitrary, {
  nil: undefined,
});

function makeScoreInput(
  scoring: ProblemScoringMetadata,
  outputs: Readonly<Record<string, string>> = {},
  probeResults: Readonly<Record<string, FakeProbeResult>> = {},
  declaredTargetIds: readonly string[] = [],
): ScoreInput {
  return { scoring, outputs, probeResults, declaredTargetIds };
}

function outputRecord(outputKey: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [outputKey]: value };
}

const flagInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(outputKeyArbitrary, outputValueArbitrary)
  .map(([flagOutputKey, outputValue]) =>
    makeScoreInput(
      { kind: "flag", flagOutputKey, points: 100 },
      outputRecord(flagOutputKey, outputValue),
    ),
  );

interface GeneratedMultiFlagFixture {
  readonly scoring: Extract<ProblemScoringMetadata, { kind: "multi-flag" }>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly outputValues: readonly (string | undefined)[];
}

const multiFlagFixtureArbitrary: fc.Arbitrary<GeneratedMultiFlagFixture> = fc
  .uniqueArray(tokenArbitrary, { minLength: 1, maxLength: 6 })
  .chain((tokens) =>
    fc
      .array(outputValueArbitrary, {
        minLength: tokens.length,
        maxLength: tokens.length,
      })
      .map((outputValues) => {
        const flags = tokens.map((token) => ({
          id: `flag-${token}`,
          label: `Flag ${token}`,
          flagOutputKey: `FlagOutput_${token}`,
          points: 10,
        }));
        const outputs: Record<string, string> = {};
        flags.forEach((flag, index) => {
          const value = outputValues[index];
          if (value !== undefined) outputs[flag.flagOutputKey] = value;
        });
        return {
          scoring: { kind: "multi-flag", flags },
          outputs,
          outputValues,
        };
      }),
  );

const multiFlagInputArbitrary = multiFlagFixtureArbitrary.map(({ scoring, outputs }) =>
  makeScoreInput(scoring, outputs),
);

const attackDetectionInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(outputKeyArbitrary, outputValueArbitrary)
  .map(([statsOutputKey, outputValue]) =>
    makeScoreInput(
      { kind: "attack-detection", statsOutputKey, pointsPerAttack: 10 },
      outputRecord(statsOutputKey, outputValue),
    ),
  );

const phasedPollingInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(outputKeyArbitrary, outputValueArbitrary)
  .map(([metaOutputKey, outputValue]) =>
    makeScoreInput(
      {
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: metaOutputKey, scorePath: "/score" },
        platformRules: { aws: { points: 10 } },
      },
      outputRecord(metaOutputKey, outputValue),
    ),
  );

const uptimeFlatInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(
    fc.constantFrom<"uptime" | "uptime-flat">("uptime", "uptime-flat"),
    outputKeyArbitrary,
    urlArbitrary,
    expectedStatusesArbitrary,
    fc.boolean(),
    optionalProbeResultArbitrary,
  )
  .map(([kind, outputKey, url, expectStatus, hasOutput, probeResult]) =>
    makeScoreInput(
      {
        kind,
        endpoints: [{ slot: outputKey, path: "/", expectStatus }],
        pointsPerSuccess: 10,
      },
      hasOutput ? { [outputKey]: url } : {},
      probeResult === undefined ? {} : { [url]: probeResult },
    ),
  );

const uptimeMultiInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(
    outputKeyArbitrary,
    urlArbitrary,
    expectedStatusesArbitrary,
    fc.boolean(),
    optionalProbeResultArbitrary,
  )
  .map(([slot, url, expectStatus, hasOutput, probeResult]) =>
    makeScoreInput(
      {
        kind: "uptime-multi",
        probedSlots: [{ slot, path: "/", expectStatus }],
        pointsAllOk: 100,
      },
      hasOutput ? { [slot]: url } : {},
      probeResult === undefined ? {} : { [url]: probeResult },
    ),
  );

const compositeProbeInputArbitrary: fc.Arbitrary<ScoreInput> = fc
  .tuple(
    tokenArbitrary,
    outputKeyArbitrary,
    urlArbitrary,
    fc.option(expectedStatusesArbitrary, { nil: undefined }),
    fc.boolean(),
    fc.boolean(),
    optionalProbeResultArbitrary,
  )
  .map(([targetToken, outputKey, url, expectStatus, isDeclared, hasOutput, probeResult]) => {
    const targetId = `target-${targetToken}`;
    return makeScoreInput(
      {
        kind: "composite-probe",
        targets: [
          {
            targetId,
            probe: "https",
            outputKey,
            ...(expectStatus === undefined ? {} : { expectStatus }),
          },
        ],
        success: "all",
        pointsAllOk: 100,
      },
      hasOutput ? { [outputKey]: url } : {},
      probeResult === undefined ? {} : { [url]: probeResult },
      isDeclared ? [targetId] : [],
    );
  });

const validScoreInputArbitrary: fc.Arbitrary<ScoreInput> = fc.oneof(
  flagInputArbitrary,
  multiFlagInputArbitrary,
  attackDetectionInputArbitrary,
  phasedPollingInputArbitrary,
  uptimeFlatInputArbitrary,
  uptimeMultiInputArbitrary,
  compositeProbeInputArbitrary,
);

interface UptimeProbeCase {
  readonly input: ScoreInput;
  readonly shouldSucceed: boolean;
}

const effectiveExpectedStatusesArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constant<readonly number[]>([]),
  expectedStatusesArbitrary,
);

const uptimeProbeCaseArbitrary: fc.Arbitrary<UptimeProbeCase> = fc
  .tuple(
    fc.constantFrom<"uptime" | "uptime-flat">("uptime", "uptime-flat"),
    outputKeyArbitrary,
    urlArbitrary,
    effectiveExpectedStatusesArbitrary,
    statusArbitrary,
    fc.boolean(),
  )
  .map(([kind, outputKey, url, declaredStatuses, status, reachable]) => {
    const effectiveExpectedStatuses =
      declaredStatuses && declaredStatuses.length > 0 ? declaredStatuses : [200];
    // The scorer preserves the legacy default-to-200 behavior even though the
    // current normalized SDK type always carries a non-empty expectStatus array.
    const scoring = {
      kind,
      endpoints: [
        {
          slot: outputKey,
          path: "/",
          ...(declaredStatuses === undefined ? {} : { expectStatus: declaredStatuses }),
        },
      ],
      pointsPerSuccess: 10,
    } as unknown as ProblemScoringMetadata;
    return {
      input: makeScoreInput(scoring, { [outputKey]: url }, { [url]: { status, reachable } }),
      shouldSucceed: reachable && effectiveExpectedStatuses.includes(status),
    };
  });

describe("runScorer property invariants", () => {
  it("should be deterministic for every generated valid scorer input", () => {
    fc.assert(
      fc.property(validScoreInputArbitrary, (input) => {
        const first = runScorer(structuredClone(input));
        const second = runScorer(structuredClone(input));
        expect(second).toEqual(first);
      }),
      PROPERTY_PARAMETERS,
    );
  });

  it("should succeed for multi-flag if and only if every declared output is non-empty", () => {
    fc.assert(
      fc.property(multiFlagFixtureArbitrary, ({ scoring, outputs, outputValues }) => {
        const result = runScorer(makeScoreInput(scoring, outputs));
        const everyDeclaredOutputIsNonEmpty = outputValues.every(
          (value) => typeof value === "string" && value.length > 0,
        );
        expect(result.outcome === "success").toBe(everyDeclaredOutputIsNonEmpty);
      }),
      PROPERTY_PARAMETERS,
    );
  });

  it("should succeed for uptime if and only if the probe is reachable with an expected status", () => {
    fc.assert(
      fc.property(uptimeProbeCaseArbitrary, ({ input, shouldSucceed }) => {
        expect(runScorer(input).outcome === "success").toBe(shouldSucceed);
      }),
      PROPERTY_PARAMETERS,
    );
  });

  it("should ignore unrelated outputs and probe results", () => {
    fc.assert(
      fc.property(
        validScoreInputArbitrary,
        nonEmptyOutputArbitrary,
        probeResultArbitrary,
        (input, unrelatedOutput, unrelatedProbeResult) => {
          const augmentedInput: ScoreInput = {
            ...input,
            outputs: {
              ...input.outputs,
              [UNRELATED_OUTPUT_KEY]: unrelatedOutput,
            },
            probeResults: {
              ...input.probeResults,
              [UNRELATED_PROBE_URL]: unrelatedProbeResult,
            },
          };
          expect(runScorer(augmentedInput)).toEqual(runScorer(input));
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("should not throw for any generated valid scorer input", () => {
    fc.assert(
      fc.property(validScoreInputArbitrary, (input) => {
        expect(() => runScorer(input)).not.toThrow();
      }),
      PROPERTY_PARAMETERS,
    );
  });
});
