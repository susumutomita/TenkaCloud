import { describe, expect, it } from "vitest";
import {
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_COMMAND_PATTERN_VECTORS,
  DEPLOY_PROBLEM_ID_PATTERN,
} from "../src/deploy-command-patterns.js";

const PATTERNS = {
  problemId: DEPLOY_PROBLEM_ID_PATTERN,
  awsAccountId: DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  region: DEPLOY_AWS_REGION_PATTERN,
} as const;

describe("deploy command patterns", () => {
  for (const field of Object.keys(PATTERNS) as (keyof typeof PATTERNS)[]) {
    it(`should accept and reject the shared ${field} vectors`, () => {
      const { accept, reject } = DEPLOY_COMMAND_PATTERN_VECTORS[field];
      for (const vector of accept) {
        expect({ field, vector, accepted: PATTERNS[field].test(vector) }).toEqual({
          field,
          vector,
          accepted: true,
        });
      }
      for (const vector of reject) {
        expect({ field, vector, accepted: PATTERNS[field].test(vector) }).toEqual({
          field,
          vector,
          accepted: false,
        });
      }
    });
  }
});
