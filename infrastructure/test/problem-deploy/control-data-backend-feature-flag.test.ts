import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithControlDataBackendTurso,
  synthWithControlDataBackendTursoMirror,
} from "../problem-deploy-backend-stack.test-helpers";

/** Logical IDs of every `AWS::DynamoDB::Table` in the template (helper for table-presence pins). */
function tableLogicalIds(tpl: Template): string[] {
  return Object.keys(tpl.findResources("AWS::DynamoDB::Table"));
}

/**
 * Issue #2290 / #2440 (ADR-049 §5.1): control-plane data backend フラグが
 * ProblemDeployBackendStack の監査 Lambda 群 (DeployApi / EventApi / CompetitorAccountsApi /
 * SystemAuditWriter) + repository seam を実際に使う GenericScoring の env に正しく反映される
 * ことを検証する (`audit-log-feature-flag.test.ts` の mirror)。
 *
 * - controlDataBackend: "turso" → 各 Lambda env に CONTROL_DATA_BACKEND="turso"
 *   (repository seam を実際に使う EventApi / GenericScoring が最低要件、残りは AUDIT_LOG_ENABLED
 *   と同じ注入面で lockstep)
 * - default (未指定 = dynamodb) → env に CONTROL_DATA_BACKEND を含めない (= 既存テンプレートと byte 互換、
 *   CFn 差分 0。factory も unset で dynamodb に fallback するので挙動不変)
 *
 * ParticipantPortalLambda / CoordinationDispatcherLambda の turso 配線は `participantPortal` を
 * 有効化した別 synth が要るため `problem-deploy-backend-stack-participant-portal-subsystem.test.ts`
 * 側で検証する (本 file の `synthWithControlDataBackendTurso` は participantPortal 無効)。
 */

// これらの construct id 断片を含む AWS::Lambda::Function が CONTROL_DATA_BACKEND を配線される 5 Lambda。
const BACKEND_LAMBDA_IDS = [
  "DeployApi",
  "EventApi",
  "CompetitorAccountsApi",
  "SystemAuditWriter",
  "GenericScoring",
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
      expect(envOf(tpl, "EventApi").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "EventApi").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      // Issue #2440: GenericScoring も repository seam (event status reconcile + manual prune
      // tick) 経由で Turso DB を直接開くため、同じ secret 参照を持つ。
      expect(envOf(tpl, "GenericScoring").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "GenericScoring").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      // The secret reference and permission belong only to the Lambdas that open the DB.
      expect(envOf(tpl, "DeployApi").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBeUndefined();
      tpl.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Resource: Match.anyValue(),
            }),
          ]),
        },
      });
      expect(JSON.stringify(tpl.toJSON())).toContain(
        ":parameter/tenkacloud/development/turso-token",
      );
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

describe("pure SQL backend does not synth Events/Teams tables (#2440 ADR-049 §5.1 Phase A5)", () => {
  it(
    "should NOT create Events/Teams AWS::DynamoDB::Table when controlDataBackend='turso' (pure SQL)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(false);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(false);
      // Deployments / ProblemEndpoints / Disruptions / CompetitorAccounts / AdminAuditLog are
      // out of A5's scope and must still exist (5 tables, byte-compat minus Events/Teams).
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(true);
      expect(ids.some((id) => id.startsWith("ProblemEndpoints"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Disruptions"))).toBe(true);
      // No CfnOutput referencing the (nonexistent) Events/Teams tables.
      expect(() => tpl.hasOutput("EventsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("TeamsTableName", {})).toThrow();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should default (dynamodb) synth Events/Teams tables and their CfnOutputs (byte-compat)",
    () => {
      const tpl = synthDefault();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(true);
      tpl.hasOutput("EventsTableName", {});
      tpl.hasOutput("TeamsTableName", {});
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still create Events/Teams tables + inject CONTROL_DATA_BACKEND='turso-mirror' when the migration-bridge backend is selected",
    () => {
      const tpl = synthWithControlDataBackendTursoMirror();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(true);
      expect(envOf(tpl, "EventApi").CONTROL_DATA_BACKEND).toBe("turso-mirror");
      expect(envOf(tpl, "GenericScoring").CONTROL_DATA_BACKEND).toBe("turso-mirror");
      tpl.hasOutput("EventsTableName", {});
      tpl.hasOutput("TeamsTableName", {});
    },
    SYNTH_TIMEOUT_MS,
  );
});
