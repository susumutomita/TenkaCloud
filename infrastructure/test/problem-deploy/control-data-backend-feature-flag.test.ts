import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithControlDataBackendTurso,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2290 (ADR-049 §5.1): control-plane data backend フラグが ProblemDeployBackendStack の
 * 監査 Lambda 群 (DeployApi / EventApi / CompetitorAccountsApi / SystemAuditWriter) の env に
 * 正しく反映されることを検証する (`audit-log-feature-flag.test.ts` の mirror)。
 *
 * - controlDataBackend: "turso" → 各 Lambda env に CONTROL_DATA_BACKEND="turso"
 *   (repository seam を実際に使う EventApi が最低要件、残りは AUDIT_LOG_ENABLED と同じ注入面で lockstep)
 * - default (未指定 = dynamodb) → env に CONTROL_DATA_BACKEND を含めない (= 既存テンプレートと byte 互換、
 *   CFn 差分 0。factory も unset で dynamodb に fallback するので挙動不変)
 */

// これらの construct id 断片を含む AWS::Lambda::Function が CONTROL_DATA_BACKEND を配線される 4 Lambda。
const BACKEND_LAMBDA_IDS = [
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

describe("control-data backend feature flag env wiring (#2290)", () => {
  it(
    "should inject CONTROL_DATA_BACKEND='turso' into every wired Lambda when turso is selected",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of BACKEND_LAMBDA_IDS) {
        expect(envOf(tpl, id).CONTROL_DATA_BACKEND, id).toBe("turso");
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should NOT add CONTROL_DATA_BACKEND by default (byte-compat, no regression)",
    () => {
      const tpl = synthDefault();
      for (const id of BACKEND_LAMBDA_IDS) {
        expect(envOf(tpl, id).CONTROL_DATA_BACKEND, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
