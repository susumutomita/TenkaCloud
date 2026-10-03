import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithAuditLogDisabled,
} from "../problem-deploy-backend-stack.test-helpers";

/** Legacy stack options cannot reactivate the removed audit writer. */
const AUDIT_LAMBDA_IDS = [
  "DeployApi",
  "EventApi",
  "CompetitorAccountsApi",
  "SystemAuditWriter",
] as const;

function envOf(tpl: Template, idFragment: string): Record<string, unknown> {
  const functions = tpl.findResources("AWS::Lambda::Function");
  const entry = Object.entries(functions).find(
    ([name]) => name.includes(idFragment) && name.includes("Function"),
  );
  expect(entry, `expected a Lambda whose logical id contains "${idFragment}"`).toBeDefined();
  return (
    (entry?.[1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      ?.Properties?.Environment?.Variables ?? {}
  );
}

describe("retired audit options do not inject writer controls", () => {
  it(
    "does not inject a collection flag for legacy disabled options",
    () => {
      const tpl = synthWithAuditLogDisabled();
      for (const id of AUDIT_LAMBDA_IDS) {
        expect(envOf(tpl, id).AUDIT_LOG_ENABLED, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "does not inject a collection flag by default",
    () => {
      const tpl = synthDefault();
      for (const id of AUDIT_LAMBDA_IDS) {
        expect(envOf(tpl, id).AUDIT_LOG_ENABLED, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
