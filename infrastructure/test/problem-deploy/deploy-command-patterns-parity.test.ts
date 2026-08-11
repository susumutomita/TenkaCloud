import {
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_COMMAND_PATTERN_VECTORS,
  DEPLOY_PROBLEM_ID_PATTERN,
} from "@TenkaCloud/trust-bridge";
import { describe, expect, it } from "vitest";
import { DeployCreateRequestedDetailSchema } from "../../lib/problem-deploy/handlers/shared/events.js";

/**
 * Drift pin for the sign-side deploy-command patterns (#2293).
 *
 * The Workers control plane pre-validates organizer commands with the
 * trust-bridge `DEPLOY_*_PATTERN` mirrors before signing an intent. This suite
 * runs the SHARED accept/reject vectors (exported next to the patterns) through
 * the mirror pattern and through the authoritative frozen
 * `DeployCreateRequestedDetailSchema`, so the two can only be changed together.
 */

const VALID_DETAIL = {
  jobId: "job-abc",
  tenantId: "tenant-a",
  problemId: "hello-world",
  problemDir: "problems/challenges/hello-world",
  teamSlug: "team-alpha",
  namePrefix: "tc-hello-world-team-alpha",
  region: "us-east-1",
  awsAccountId: "111111111111",
};

type PatternField = keyof typeof DEPLOY_COMMAND_PATTERN_VECTORS;

const PATTERNS: Record<PatternField, RegExp> = {
  problemId: DEPLOY_PROBLEM_ID_PATTERN,
  awsAccountId: DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  region: DEPLOY_AWS_REGION_PATTERN,
};

function schemaAccepts(field: PatternField, value: string): boolean {
  return DeployCreateRequestedDetailSchema.safeParse({ ...VALID_DETAIL, [field]: value }).success;
}

describe("deploy-command pattern parity with the frozen detail schema (#2293)", () => {
  for (const field of Object.keys(PATTERNS) as PatternField[]) {
    it(`should accept/reject ${field} vectors identically to DeployCreateRequestedDetailSchema`, () => {
      const { accept, reject } = DEPLOY_COMMAND_PATTERN_VECTORS[field];
      for (const vector of [...accept, ...reject]) {
        expect({ field, vector, accepted: PATTERNS[field].test(vector) }).toEqual({
          field,
          vector,
          accepted: schemaAccepts(field, vector),
        });
      }
    });
  }
});
