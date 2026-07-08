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

function lambdaIds(tpl: Template): string[] {
  return Object.keys(tpl.findResources("AWS::Lambda::Function"));
}

function definitionToJson(definitionString: unknown): string {
  if (typeof definitionString === "string") return definitionString;
  const join = (
    definitionString as { "Fn::Join": [string, Array<string | Record<string, unknown>>] }
  )["Fn::Join"];
  return join[1].map((part) => (typeof part === "string" ? part : "ARN_PLACEHOLDER")).join("");
}

function deployCreateDefinition(tpl: Template): string {
  const definitions = Object.values(tpl.findResources("AWS::StepFunctions::StateMachine")).map(
    (resource) =>
      definitionToJson(
        (resource as { Properties?: { DefinitionString?: unknown } }).Properties?.DefinitionString,
      ),
  );
  const definition = definitions.find(
    (candidate) =>
      candidate.includes('"StartDeployCodeBuild"') || candidate.includes('"InvokeCfnDeploy"'),
  );
  expect(definition).toBeDefined();
  return definition ?? "";
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
      expect(envOf(tpl, "DeployStatusWriter").CONTROL_DATA_BACKEND).toBe("turso");
      expect(envOf(tpl, "DeployStatusWriter").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "DeployStatusWriter").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
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
      expect(lambdaIds(tpl).some((id) => id.includes("DeployStatusWriter"))).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("DeployCreate SFN SQL status-writer branch (#2441 Phase B PR-5)", () => {
  it(
    "should use Lambda status writes and no DynamoUpdateItem integration when controlDataBackend='turso'",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      const definition = deployCreateDefinition(tpl);

      expect(lambdaIds(tpl).some((id) => id.includes("DeployStatusWriter"))).toBe(true);
      expect(definition).toContain('"transition":"markInProgress"');
      expect(definition).toContain('"transition":"markSucceeded"');
      expect(definition).toContain('"transition":"markFailed"');
      expect(definition).not.toContain("dynamodb:updateItem");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep native DDB status writes for default and mirror backends",
    () => {
      const defaultDefinition = deployCreateDefinition(synthDefault());
      const mirrorTpl = synthWithControlDataBackendTursoMirror();
      const mirrorDefinition = deployCreateDefinition(mirrorTpl);

      expect(defaultDefinition).toContain("dynamodb:updateItem");
      expect(mirrorDefinition).toContain("dynamodb:updateItem");
      expect(lambdaIds(mirrorTpl).some((id) => id.includes("DeployStatusWriter"))).toBe(false);
      expect(mirrorDefinition).not.toContain('"transition":"markSucceeded"');
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("pure SQL backend does not synth Events/Teams/Deployments tables (#2440 A5 / #2441 Phase B PR-6)", () => {
  it(
    "should NOT create Events/Teams/Deployments AWS::DynamoDB::Table when controlDataBackend='turso' (pure SQL)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(false);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(false);
      // [Issue #2441 Phase B PR-6] Deployments (GSI3 本、単体最大のコスト源) も pure SQL では
      // synth されない。ProblemEndpoints / Disruptions / CompetitorAccounts / AdminAuditLog は
      // 依然 out of scope で存在する (4 tables remain, byte-compat minus Events/Teams/Deployments)。
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(false);
      expect(ids.some((id) => id.startsWith("ProblemEndpoints"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Disruptions"))).toBe(true);
      expect(ids.some((id) => id.startsWith("CompetitorAccounts"))).toBe(true);
      expect(ids.some((id) => id.startsWith("AdminAuditLog"))).toBe(true);
      // No CfnOutput referencing the (nonexistent) Events/Teams/Deployments tables.
      expect(() => tpl.hasOutput("EventsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("TeamsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("DeploymentsTableName", {})).toThrow();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should default (dynamodb) synth Events/Teams/Deployments tables and their CfnOutputs (byte-compat)",
    () => {
      const tpl = synthDefault();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(true);
      tpl.hasOutput("EventsTableName", {});
      tpl.hasOutput("TeamsTableName", {});
      tpl.hasOutput("DeploymentsTableName", {});
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still create Events/Teams/Deployments tables + inject CONTROL_DATA_BACKEND='turso-mirror' when the migration-bridge backend is selected",
    () => {
      const tpl = synthWithControlDataBackendTursoMirror();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(true);
      expect(envOf(tpl, "EventApi").CONTROL_DATA_BACKEND).toBe("turso-mirror");
      expect(envOf(tpl, "GenericScoring").CONTROL_DATA_BACKEND).toBe("turso-mirror");
      tpl.hasOutput("EventsTableName", {});
      tpl.hasOutput("TeamsTableName", {});
      tpl.hasOutput("DeploymentsTableName", {});
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit DEPLOYMENTS_TABLE_NAME entirely from DeployApi/EventApi/GenericScoring env under turso (same conditional-spread pattern as EVENTS_TABLE_NAME)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of ["DeployApi", "EventApi", "GenericScoring"] as const) {
        expect(envOf(tpl, id).DEPLOYMENTS_TABLE_NAME, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("DeployDelete SFN SQL status-writer branch (#2441 Phase B PR-6)", () => {
  function deployDeleteDefinition(tpl: Template): string {
    const definitions = Object.values(tpl.findResources("AWS::StepFunctions::StateMachine")).map(
      (resource) =>
        definitionToJson(
          (resource as { Properties?: { DefinitionString?: unknown } }).Properties
            ?.DefinitionString,
        ),
    );
    const definition = definitions.find(
      (candidate) =>
        candidate.includes('"StartDeleteCodeBuild"') || candidate.includes('"InvokeCfnDelete"'),
    );
    expect(definition).toBeDefined();
    return definition ?? "";
  }

  it(
    "should share the DeployStatusWriter Lambda for MarkDeleted/MarkFailed and drop DynamoUpdateItem when controlDataBackend='turso'",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      const definition = deployDeleteDefinition(tpl);

      // The same DeployStatusWriter Lambda serves both DeployCreate and DeployDelete — no
      // second writer Lambda is created.
      expect(lambdaIds(tpl).filter((id) => id.includes("DeployStatusWriter"))).toHaveLength(1);
      expect(definition).toContain('"transition":"markDeleted"');
      expect(definition).toContain('"transition":"markFailed"');
      expect(definition).not.toContain("dynamodb:updateItem");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep native DDB status writes for default and mirror backends",
    () => {
      const defaultDefinition = deployDeleteDefinition(synthDefault());
      const mirrorDefinition = deployDeleteDefinition(synthWithControlDataBackendTursoMirror());

      expect(defaultDefinition).toContain("dynamodb:updateItem");
      expect(mirrorDefinition).toContain("dynamodb:updateItem");
      expect(defaultDefinition).not.toContain('"transition":"markDeleted"');
      expect(mirrorDefinition).not.toContain('"transition":"markDeleted"');
    },
    SYNTH_TIMEOUT_MS,
  );
});
