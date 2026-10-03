import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithControlDataBackendTurso,
} from "../problem-deploy-backend-stack.test-helpers";

/** Logical IDs of every `AWS::DynamoDB::Table` in the template (helper for table-presence pins). */
function tableLogicalIds(tpl: Template): string[] {
  return Object.keys(tpl.findResources("AWS::DynamoDB::Table"));
}

/**
 * Issue #2290 / #2440: control-plane data backend フラグが
 * ProblemDeployBackendStack の監査 Lambda 群 (DeployApi / EventApi / CompetitorAccountsApi /
 * SystemAuditWriter / ExternalIdAudit) + repository seam を実際に使う GenericScoring の env に
 * 正しく反映されることを検証する (`audit-log-feature-flag.test.ts` の mirror)。
 *
 * - controlDataBackend: "turso" → 各 Lambda env に CONTROL_DATA_BACKEND="turso"
 *   (repository seam を実際に使う EventApi / GenericScoring / CompetitorAccountsApi /
 *   ExternalIdAudit が最低要件、残りは AUDIT_LOG_ENABLED と同じ注入面で lockstep)
 * - default (未指定 = dynamodb) → env に CONTROL_DATA_BACKEND を含めない (= 既存テンプレートと byte 互換、
 *   CFn 差分 0。factory も unset で dynamodb に fallback するので挙動不変)
 *
 * ParticipantPortalLambda / CoordinationDispatcherLambda の turso 配線は `participantPortal` を
 * 有効化した別 synth が要るため `problem-deploy-backend-stack-participant-portal-subsystem.test.ts`
 * 側で検証する (本 file の `synthWithControlDataBackendTurso` は participantPortal 無効)。
 */

// これらの construct id 断片を含む AWS::Lambda::Function が CONTROL_DATA_BACKEND を配線される 7 Lambda。
// [Issue #2442 / Phase C2] ExternalIdAudit を追加 (CompetitorAccounts repository seam の日次監査)。
// [Issue #2442 / Phase C3] DisruptionExecutor を追加 (Disruptions EXEC# claim repository seam)。
const BACKEND_LAMBDA_IDS = [
  "DeployApi",
  "EventApi",
  "CompetitorAccountsApi",
  "SystemAuditWriter",
  "GenericScoring",
  "ExternalIdAudit",
  "DisruptionExecutor",
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
      // [Issue #2442 / Phase C2] CompetitorAccountsApi / ExternalIdAudit both "open the DB"
      // for the CompetitorAccounts / SamlConfig repository seam (CRUD + daily rotation audit),
      // so they carry the same Turso executor wiring as EventApi/GenericScoring/DeployStatusWriter.
      expect(envOf(tpl, "CompetitorAccountsApi").TURSO_DATABASE_URL).toBe(
        "libsql://example.turso.io",
      );
      expect(envOf(tpl, "CompetitorAccountsApi").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      expect(envOf(tpl, "ExternalIdAudit").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "ExternalIdAudit").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      // [Issue #2442 / Phase C3] DisruptionExecutor "opens the DB" for the Disruptions EXEC#
      // claim repository seam, so it carries the same Turso executor wiring.
      expect(envOf(tpl, "DisruptionExecutor").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "DisruptionExecutor").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      // [Issue #2442 / Phase C4] SystemAuditWriter actually calls `writeAuditEvent` (SBT tenant
      // onboarding/offboarding audit), so it now "opens the DB" for the AdminAuditLog repository
      // seam and carries the same Turso executor wiring.
      expect(envOf(tpl, "SystemAuditWriter").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "SystemAuditWriter").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
      // [Issue #2560] DeployApi *does* open the DB: `startDeployment` resolves
      // `resolveDeploymentsRepository` and `resolveVerifiedCompetitorAccount` resolves
      // `resolveCompetitorAccountsRepository`, both of which acquire a SQL executor in pure
      // turso mode. It therefore carries the same Turso executor wiring as EventApi/
      // GenericScoring/CompetitorAccountsApi (previously this was wired as "scope out",
      // which made every deploy/list/retry call throw in pure turso mode).
      expect(envOf(tpl, "DeployApi").TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(envOf(tpl, "DeployApi").TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
        "/tenkacloud/development/turso-token",
      );
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
    "should keep native DDB status writes for the default backend",
    () => {
      const defaultDefinition = deployCreateDefinition(synthDefault());

      expect(defaultDefinition).toContain("dynamodb:updateItem");
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("pure SQL backend does not synth Events/Teams/Deployments/ProblemEndpoints/CompetitorAccounts/Disruptions/AdminAuditLog tables (#2440 A5 / #2441 Phase B PR-6 / #2442 Phase C1+C2+C3+C4)", () => {
  it(
    "should NOT create Events/Teams/Deployments/ProblemEndpoints/CompetitorAccounts/Disruptions/AdminAuditLog AWS::DynamoDB::Table when controlDataBackend='turso' (pure SQL)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(false);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(false);
      // [Issue #2441 Phase B PR-6] Deployments (GSI3 本、単体最大のコスト源) も pure SQL では
      // synth されない。
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(false);
      // [Issue #2442 Phase C1] ProblemEndpoints (最小テーブル、条件付き書き込み・Scan 無し) も
      // pure SQL では synth されない。
      expect(ids.some((id) => id.startsWith("ProblemEndpoints"))).toBe(false);
      // [Issue #2442 Phase C2] CompetitorAccounts (SAML_CONFIG 行が同 partition に同居) も
      // pure SQL では synth されない。
      expect(ids.some((id) => id.startsWith("CompetitorAccounts"))).toBe(false);
      // [Issue #2442 Phase C3] Disruptions (AUDIT#/RECUR#/REQUEST#/EXEC# の 4 row shape が同居) も
      // pure SQL では synth されない。
      expect(ids.some((id) => id.startsWith("Disruptions"))).toBe(false);
      // [Issue #2442 Phase C4] AdminAuditLog (GSI1 ACTOR# 逆引き) も pure SQL では synth
      // されない — write 元 6 Lambda + admin-insight の read は repository seam
      // (`writeAuditEvent` / `resolveAdminAuditLogRepository`) 経由で SQL executor 直結する。
      expect(ids.some((id) => id.startsWith("AdminAuditLog"))).toBe(false);
      // No CfnOutput referencing the (nonexistent) Events/Teams/Deployments/ProblemEndpoints/
      // CompetitorAccounts tables.
      expect(() => tpl.hasOutput("EventsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("TeamsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("DeploymentsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("ProblemEndpointsTableName", {})).toThrow();
      expect(() => tpl.hasOutput("CompetitorAccountsTableName", {})).toThrow();
      // Pure SQL has no event-hot DynamoDB resources, so capacity operations must disappear
      // end-to-end rather than leaving a dead runbook, output, env value, or broad CW permission.
      expect(
        Object.keys(tpl.findResources("AWS::SSM::Document")).some((id) =>
          id.includes("EventCapacityRunbook"),
        ),
      ).toBe(false);
      expect(() => tpl.hasOutput("EventCapacityRunbookName", {})).toThrow();
      expect(envOf(tpl, "EventApi").CAPACITY_RUNBOOK_DOCUMENT_NAME).toBeUndefined();
      expect(JSON.stringify(tpl.toJSON())).not.toContain("cloudwatch:GetMetricData");
      // [Issue #2680] POST /admin/capacity の runbook 起動 IAM (StartAutomationExecution +
      // automation-definition ARN) も document/role が無い pure SQL では一切付与されない。
      expect(JSON.stringify(tpl.toJSON())).not.toContain("ssm:StartAutomationExecution");
      expect(JSON.stringify(tpl.toJSON())).not.toContain("automation-definition");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should default (dynamodb) synth Events/Teams/Deployments/ProblemEndpoints/CompetitorAccounts/Disruptions/AdminAuditLog tables and their CfnOutputs (byte-compat)",
    () => {
      const tpl = synthDefault();
      const ids = tableLogicalIds(tpl);
      expect(ids.some((id) => id.startsWith("Events"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Teams"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Deployments"))).toBe(true);
      expect(ids.some((id) => id.startsWith("ProblemEndpoints"))).toBe(true);
      expect(ids.some((id) => id.startsWith("CompetitorAccounts"))).toBe(true);
      expect(ids.some((id) => id.startsWith("Disruptions"))).toBe(true);
      expect(ids.some((id) => id.startsWith("AdminAuditLog"))).toBe(true);
      tpl.hasOutput("EventsTableName", {});
      tpl.hasOutput("TeamsTableName", {});
      tpl.hasOutput("DeploymentsTableName", {});
      tpl.hasOutput("ProblemEndpointsTableName", {});
      tpl.hasOutput("CompetitorAccountsTableName", {});
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should fall back ADMIN_AUDIT_LOG_TABLE_NAME to '' on DeployApi/EventApi/CompetitorAccountsApi under turso (pre-existing `?? \"\"` pattern, left as-is per #2442 Phase C4 scope)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of ["DeployApi", "EventApi", "CompetitorAccountsApi"] as const) {
        expect(envOf(tpl, id).ADMIN_AUDIT_LOG_TABLE_NAME, id).toBe("");
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit ADMIN_AUDIT_LOG_TABLE_NAME entirely from SystemAuditWriter env under turso (#2442 Phase C4, newly-converted from a required Table prop, matches the C1-C3 conditional-spread convention)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      expect(envOf(tpl, "SystemAuditWriter").ADMIN_AUDIT_LOG_TABLE_NAME).toBeUndefined();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still inject ADMIN_AUDIT_LOG_TABLE_NAME for the default backend (byte-compat)",
    () => {
      expect(envOf(synthDefault(), "EventApi").ADMIN_AUDIT_LOG_TABLE_NAME).toBeDefined();
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

  it(
    "should omit PROBLEM_ENDPOINTS_TABLE_NAME entirely from EventApi/GenericScoring env under turso (#2442 Phase C1, same conditional-spread pattern)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of ["EventApi", "GenericScoring"] as const) {
        expect(envOf(tpl, id).PROBLEM_ENDPOINTS_TABLE_NAME, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still inject PROBLEM_ENDPOINTS_TABLE_NAME for the default backend (byte-compat)",
    () => {
      expect(envOf(synthDefault(), "EventApi").PROBLEM_ENDPOINTS_TABLE_NAME).toBeDefined();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit COMPETITOR_ACCOUNTS_TABLE_NAME entirely from DeployApi/EventApi/CompetitorAccountsApi/GenericScoring/ExternalIdAudit env under turso (#2442 Phase C2, same conditional-spread pattern)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of [
        "DeployApi",
        "EventApi",
        "CompetitorAccountsApi",
        "GenericScoring",
        "ExternalIdAudit",
      ] as const) {
        expect(envOf(tpl, id).COMPETITOR_ACCOUNTS_TABLE_NAME, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still inject COMPETITOR_ACCOUNTS_TABLE_NAME for the default backend (byte-compat)",
    () => {
      expect(envOf(synthDefault(), "EventApi").COMPETITOR_ACCOUNTS_TABLE_NAME).toBeDefined();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit DISRUPTIONS_TABLE_NAME entirely from EventApi/DisruptionExecutor/GenericScoring env under turso (#2442 Phase C3, same conditional-spread pattern)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const id of ["EventApi", "DisruptionExecutor", "GenericScoring"] as const) {
        expect(envOf(tpl, id).DISRUPTIONS_TABLE_NAME, id).toBeUndefined();
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still inject DISRUPTIONS_TABLE_NAME for the default backend (byte-compat)",
    () => {
      expect(envOf(synthDefault(), "EventApi").DISRUPTIONS_TABLE_NAME).toBeDefined();
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
    "should keep native DDB status writes for the default backend",
    () => {
      const defaultDefinition = deployDeleteDefinition(synthDefault());

      expect(defaultDefinition).toContain("dynamodb:updateItem");
      expect(defaultDefinition).not.toContain('"transition":"markDeleted"');
    },
    SYNTH_TIMEOUT_MS,
  );
});
