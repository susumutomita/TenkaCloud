import {
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_PROBLEM_ID_PATTERN,
} from "@TenkaCloud/trust-bridge";
import { describe, expect, it } from "vitest";
import { DeployCreateRequestedDetailSchema } from "../../lib/problem-deploy/handlers/shared/events.js";

/**
 * Drift pin for the sign-side deploy-command patterns (ADR-049 Phase 4 / #2293).
 *
 * The Workers control plane pre-validates organizer commands with the
 * trust-bridge `DEPLOY_*_PATTERN` mirrors before signing an intent. This suite
 * runs the SAME accept/reject vectors through the mirror pattern and through the
 * authoritative frozen `DeployCreateRequestedDetailSchema`, so the two can only
 * be changed together.
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

function schemaAccepts(field: "problemId" | "region" | "awsAccountId", value: string): boolean {
  return DeployCreateRequestedDetailSchema.safeParse({ ...VALID_DETAIL, [field]: value }).success;
}

interface ParityCase {
  readonly field: "problemId" | "region" | "awsAccountId";
  readonly pattern: RegExp;
  readonly vectors: readonly string[];
}

const CASES: readonly ParityCase[] = [
  {
    field: "problemId",
    pattern: DEPLOY_PROBLEM_ID_PATTERN,
    vectors: [
      "a",
      "hello-world",
      "a1-b2-c3",
      "x".repeat(64),
      "",
      "Hello-World",
      "hello_world",
      "-leading",
      "trailing-",
      "x".repeat(65),
    ],
  },
  {
    field: "awsAccountId",
    pattern: DEPLOY_AWS_ACCOUNT_ID_PATTERN,
    vectors: ["111111111111", "", "1234", "1111111111111", "11111111111a"],
  },
  {
    field: "region",
    pattern: DEPLOY_AWS_REGION_PATTERN,
    vectors: [
      "ap-northeast-1",
      "us-east-1",
      "eu-west-2",
      "",
      "AP-NORTHEAST-1",
      "us-east",
      "us-east-1a",
    ],
  },
];

describe("deploy-command pattern parity with the frozen detail schema (#2293)", () => {
  for (const { field, pattern, vectors } of CASES) {
    it(`should accept/reject ${field} vectors identically to DeployCreateRequestedDetailSchema`, () => {
      for (const vector of vectors) {
        expect({ field, vector, accepted: pattern.test(vector) }).toEqual({
          field,
          vector,
          accepted: schemaAccepts(field, vector),
        });
      }
    });
  }
});
