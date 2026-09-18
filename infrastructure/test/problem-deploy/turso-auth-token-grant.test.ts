import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthWithControlDataBackendTurso,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Reading the Turso auth token needs TWO permissions, and the platform only
 * ever granted one.
 *
 * `sql-executor-cache.ts` opens the libSQL client on cold start by calling
 * `GetParameter(WithDecryption: true)` on an SSM **SecureString**. A
 * SecureString is envelope-encrypted under the AWS managed key
 * `alias/aws/ssm`, so that call needs `ssm:GetParameter` *and* `kms:Decrypt`
 * on that key for this parameter's encryption context. Every construct granted
 * the first and none granted the second: the `kms:Decrypt` those Lambdas
 * already carry is conditioned on `kms:EncryptionContext:PARAMETER_ARN`
 * matching the ExternalId / sakura / azure / gcp credential paths, which the
 * Turso parameter is not one of.
 *
 * The result is an `AccessDeniedException` inside the executor cache's promise
 * on the first control-data read, surfacing to the operator as a bare 500
 * `internal_error` — the Competitor Accounts screen's symptom. It is invisible
 * on the DynamoDB backend, which never reads the token.
 *
 * This test is written over EVERY Lambda that carries the token's env rather
 * than over a list of construct names, so a newly Turso-wired Lambda cannot
 * ship the env without the pair of grants that makes it usable. Thirteen
 * constructs each hand-rolled the `ssm:GetParameter` statement, which is
 * exactly why one missing companion statement stayed invisible thirteen times;
 * they now share `grantTursoAuthTokenRead`.
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
    "gives every token-reading Lambda kms:Decrypt scoped to that parameter's encryption context",
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
          decrypt.length,
          `${id} can read the SecureString but cannot decrypt it — GetParameter(WithDecryption) will be denied`,
        ).toBeGreaterThan(0);
        // Scoped, not blanket: `Resource: "*"` is unavoidable (the AWS managed
        // key's ARN is not known at synth time), so the encryption-context
        // condition is what keeps this to one parameter.
        for (const statement of decrypt) {
          const condition = statement.Condition as
            | { StringEquals?: Record<string, unknown> }
            | undefined;
          expect(
            condition?.StringEquals?.["kms:EncryptionContext:PARAMETER_ARN"],
            `${id}'s kms:Decrypt must be pinned to the token parameter's encryption context`,
          ).toBeDefined();
        }
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
