import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthWithControlDataBackendTurso,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Every Lambda that carries the Turso token's env must also be able to read
 * it — and must not carry more than that.
 *
 * `sql-executor-cache.ts` opens the libSQL client on cold start by calling
 * `GetParameter(WithDecryption: true)` on an SSM **SecureString**. That call
 * needs `ssm:GetParameter` on the parameter. The decrypt under the AWS managed
 * key `alias/aws/ssm` is authorised by that key's own policy (calls made via
 * SSM), so the Lambda role needs no `kms:Decrypt` for it, and the platform
 * deliberately grants none: an extra `kms:Decrypt` on `Resource: "*"` would
 * add a declared permission without adding a real one.
 *
 * Thirteen constructs each hand-rolled the `ssm:GetParameter` statement, so
 * the same statement could drift thirteen ways; they now share
 * `grantTursoAuthTokenRead`. This test is written over EVERY Lambda that
 * carries the token's env rather than over a list of construct names, so a
 * newly Turso-wired Lambda cannot ship the env without the grant that makes
 * it usable, nor with a grant the helper decided against.
 */

const TOKEN_PARAMETER_PATH = "parameter/tenkacloud/development/turso-token";

interface LambdaResource {
  readonly Properties?: {
    readonly Role?: unknown;
    readonly Environment?: { readonly Variables?: Record<string, unknown> };
  };
}

interface PolicyResource {
  readonly Properties?: {
    readonly Roles?: readonly unknown[];
    readonly PolicyDocument?: { readonly Statement?: readonly Record<string, unknown>[] };
  };
}

/** The role's logical id out of a Lambda's `Role: { "Fn::GetAtt": [id, "Arn"] }`. */
function roleLogicalId(fn: LambdaResource): string | undefined {
  const role = fn.Properties?.Role as { "Fn::GetAtt"?: readonly unknown[] } | undefined;
  const target = role?.["Fn::GetAtt"]?.[0];
  return typeof target === "string" ? target : undefined;
}

/** Every Lambda in the template whose env carries the Turso token parameter name. */
function tursoWiredLambdas(tpl: Template): [string, LambdaResource][] {
  return Object.entries(
    tpl.findResources("AWS::Lambda::Function") as Record<string, LambdaResource>,
  ).filter(([, fn]) => fn.Properties?.Environment?.Variables?.TURSO_AUTH_TOKEN_PARAMETER_NAME);
}

/** Every policy statement attached to `roleId`, across all inline policies. */
function statementsForRole(tpl: Template, roleId: string): Record<string, unknown>[] {
  const policies = tpl.findResources("AWS::IAM::Policy") as Record<string, PolicyResource>;
  const statements: Record<string, unknown>[] = [];
  for (const policy of Object.values(policies)) {
    const attached = (policy.Properties?.Roles ?? []).some(
      (entry) => (entry as { Ref?: unknown })?.Ref === roleId,
    );
    if (attached) statements.push(...(policy.Properties?.PolicyDocument?.Statement ?? []));
  }
  return statements;
}

function actionsOf(statement: Record<string, unknown>): string[] {
  const action = statement.Action;
  if (typeof action === "string") return [action];
  return Array.isArray(action)
    ? action.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Whether the statement's JSON mentions the Turso parameter path literal. */
function mentionsTokenParameter(statement: Record<string, unknown>): boolean {
  return JSON.stringify(statement).includes(TOKEN_PARAMETER_PATH);
}

describe("Turso auth token grants (turso backend)", () => {
  it(
    "wires the token env into at least the Lambdas that open the control-data DB",
    () => {
      const wired = tursoWiredLambdas(synthWithControlDataBackendTurso()).map(([id]) => id);
      // Guards the two helpers above: a template shape change that stopped
      // matching would otherwise make every assertion below vacuously true.
      expect(wired.length).toBeGreaterThan(0);
      for (const fragment of ["DeployApi", "EventApi", "CompetitorAccountsApi", "GenericScoring"]) {
        expect(
          wired.some((id) => id.includes(fragment)),
          `${fragment} should read the token`,
        ).toBe(true);
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "gives every token-reading Lambda ssm:GetParameter on that parameter",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const [id, fn] of tursoWiredLambdas(tpl)) {
        const roleId = roleLogicalId(fn);
        expect(roleId, `${id} should have a role`).toBeDefined();
        const granted = statementsForRole(tpl, roleId as string).some(
          (statement) =>
            actionsOf(statement).includes("ssm:GetParameter") && mentionsTokenParameter(statement),
        );
        expect(granted, `${id} is missing ssm:GetParameter on the Turso token`).toBe(true);
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "does not grant kms:Decrypt for the token (the AWS managed key policy already covers it)",
    () => {
      const tpl = synthWithControlDataBackendTurso();
      for (const [id, fn] of tursoWiredLambdas(tpl)) {
        const roleId = roleLogicalId(fn);
        expect(roleId, `${id} should have a role`).toBeDefined();
        const decrypt = statementsForRole(tpl, roleId as string).filter(
          (statement) =>
            actionsOf(statement).includes("kms:Decrypt") && mentionsTokenParameter(statement),
        );
        expect(
          decrypt,
          `${id} carries a kms:Decrypt for the Turso token that alias/aws/ssm does not need`,
        ).toEqual([]);
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
