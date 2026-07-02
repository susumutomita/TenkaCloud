import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithBulkDistributedMap,
} from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2232: `useBulkDistributedMap` was fully wired stack prop → Lambda env → handler →
 * DistributedMap state machine branch, but no `CDK_PARAM_*` ever set it true in production —
 * the DistributedMap branch was permanently unreachable outside tests. resolve.ts now wires
 * `CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP` (see test/app-config/resolve-branches.test.ts).
 * These tests pin the stack-level contract the resolved flag depends on.
 */
describe("ProblemDeployBackendStack — useBulkDistributedMap (#2232)", () => {
  function findEventApiEnv(
    tpl: ReturnType<typeof synthDefault>,
  ): Record<string, unknown> | undefined {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const eventApi = Object.entries(functions).find(
      ([name]) => name.includes("EventApi") && name.includes("Function"),
    );
    return (
      eventApi?.[1] as {
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }
    )?.Properties?.Environment?.Variables;
  }

  it(
    "should default BULK_DEPLOY_VIA_DISTRIBUTED_MAP to false when useBulkDistributedMap is unset",
    () => {
      const env = findEventApiEnv(synthDefault());
      expect(env?.BULK_DEPLOY_VIA_DISTRIBUTED_MAP).toBe("false");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should set BULK_DEPLOY_VIA_DISTRIBUTED_MAP to true when useBulkDistributedMap: true",
    () => {
      const env = findEventApiEnv(synthWithBulkDistributedMap());
      expect(env?.BULK_DEPLOY_VIA_DISTRIBUTED_MAP).toBe("true");
    },
    SYNTH_TIMEOUT_MS,
  );
});
