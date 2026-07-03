import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithAuditLogDisabled,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2311: 監査ログ feature flag が ProblemDeployBackendStack の監査 Lambda 群
 * (DeployApi / EventApi / CompetitorAccountsApi / SystemAuditWriter) の env に正しく
 * 反映されることを検証する。
 *
 * - auditLogEnabled: false → 各 Lambda env に AUDIT_LOG_ENABLED="false" (= writeAuditEvent 無効化)
 * - default (未指定) → env に AUDIT_LOG_ENABLED を含めない (= 既存テンプレートと byte 互換、CFn 差分 0)
 */

// これらの construct id 断片を含む AWS::Lambda::Function が監査を書く 4 Lambda。
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

describe("audit-log feature flag env wiring (#2311)", () => {
  it(
    "should inject AUDIT_LOG_ENABLED='false' into every audit-writing Lambda when disabled",
    () => {
      const tpl = synthWithAuditLogDisabled();
      for (const id of AUDIT_LAMBDA_IDS) {
        expect(envOf(tpl, id).AUDIT_LOG_ENABLED, id).toBe("false");
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should NOT add AUDIT_LOG_ENABLED by default (byte-compat, no regression)",
    () => {
      const tpl = synthDefault();
      for (const id of AUDIT_LAMBDA_IDS) {
        expect(envOf(tpl, id).AUDIT_LOG_ENABLED, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
