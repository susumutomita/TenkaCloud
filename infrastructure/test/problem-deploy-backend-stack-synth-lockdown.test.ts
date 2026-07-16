import type { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthLite,
  synthWithCodeBuild,
  synthWithControlDataBackendTurso,
} from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2527 Slice 0: characterization lockdown of the ProblemDeployBackendStack synth
 * surface, ahead of the Slice 5 refactor that decomposes the stack constructor into
 * composition-only subsystems.
 *
 * The existing problem-deploy-backend-stack-*.test.ts files assert behavior with partial
 * matching (`hasResourceProperties` / `arrayContaining` / `resourceCountIs`), so a refactor
 * that accidentally re-parents a construct (new logical ID = CFn REPLACE/DELETE), drops an
 * IAM statement, loses a Lambda env var, or removes a CfnOutput consumed cross-stack could
 * still pass them. This suite pins the full surface at four grains, per stack-shape variant:
 *
 *   1. the logical ID inventory (REPLACE/DELETE guard — same grain as wire-synth.test.ts)
 *   2. the complete CfnOutputs map (cross-stack / install.sh consumers)
 *   3. every Lambda function's environment variables (handler wiring contract)
 *   4. every IAM role + policy document (least-privilege surface)
 *   5. every Lambda function's remaining properties minus Code (Role binding / Handler /
 *      Runtime / Timeout / MemorySize — catches a same-logical-ID re-wire that grains 1-4
 *      would miss; Code is excluded because its asset hash tracks handler-source content,
 *      not stack wiring)
 *
 * Slice 5 must keep this suite green WITHOUT touching the snapshots — that is the
 * machine-checked meaning of "Physical impact: NO-OP". Only a PR that intentionally changes
 * the deployed shape may update them (and must label the CFn diff in its PR body).
 *
 * The participantPortal variant is excluded: a full synth of that branch requires the
 * `apps/participant-portal/dist` asset (absent in CI — see the note on
 * `synthParticipantPortalLambdaOnly` in the test helpers). Its wiring stays covered by
 * problem-deploy-backend-stack-participant-portal-subsystem.test.ts.
 */

function sortByKey<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, T>;
}

/** Sorted logical ID inventory — a changed entry means CFn would REPLACE/DELETE something. */
function logicalIds(tpl: Template): string[] {
  const { Resources = {} } = tpl.toJSON() as { Resources?: Record<string, unknown> };
  return Object.keys(Resources).sort();
}

/** logicalId → Environment.Variables for every Lambda function (incl. CDK providers). */
function lambdaEnvironments(tpl: Template): Record<string, unknown> {
  return sortByKey(
    Object.fromEntries(
      Object.entries(tpl.findResources("AWS::Lambda::Function")).map(([logicalId, resource]) => [
        logicalId,
        resource.Properties?.Environment?.Variables ?? {},
      ]),
    ),
  );
}

/**
 * logicalId → every Lambda property except Code (asset hash) and Environment (grain 3).
 * Pins the Role binding, Handler, Runtime, Timeout, MemorySize, etc. — a decomposed
 * constructor handing a subsystem the wrong role would keep grains 1-4 green otherwise.
 */
function lambdaWiring(tpl: Template): Record<string, unknown> {
  return sortByKey(
    Object.fromEntries(
      Object.entries(tpl.findResources("AWS::Lambda::Function")).map(([logicalId, resource]) => {
        const { Code: _code, Environment: _env, ...wiring } = resource.Properties ?? {};
        return [logicalId, wiring];
      }),
    ),
  );
}

/** logicalId → policy document for the whole IAM surface (roles + attached policies). */
function iamSurface(tpl: Template): Record<string, unknown> {
  const roles = Object.fromEntries(
    Object.entries(tpl.findResources("AWS::IAM::Role")).map(([logicalId, resource]) => [
      logicalId,
      {
        AssumeRolePolicyDocument: resource.Properties?.AssumeRolePolicyDocument,
        ManagedPolicyArns: resource.Properties?.ManagedPolicyArns,
        Policies: resource.Properties?.Policies,
      },
    ]),
  );
  const policies = Object.fromEntries(
    Object.entries(tpl.findResources("AWS::IAM::Policy")).map(([logicalId, resource]) => [
      logicalId,
      {
        PolicyDocument: resource.Properties?.PolicyDocument,
        Roles: resource.Properties?.Roles,
      },
    ]),
  );
  return { ...sortByKey(roles), ...sortByKey(policies) };
}

/**
 * The stack-shape variants whose synth surface the Slice 5 refactor must reproduce
 * byte-for-byte. Env-only variants (bulk distributed map / audit off / quota) reuse the
 * default resource shape and stay pinned by their dedicated test files.
 */
const VARIANTS: ReadonlyArray<readonly [name: string, synth: () => Template]> = [
  ["lambda-deploy default", synthDefault],
  ["codebuild rollback path", synthWithCodeBuild],
  ["pure-sql turso backend", synthWithControlDataBackendTurso],
  ["lite mode (no eventBusArn)", () => synthLite("TestStackLite", "test-source-bucket")],
];

describe.each(
  VARIANTS,
)("ProblemDeployBackendStack synth lockdown (#2527 Slice 0) — %s", (_name, synth) => {
  it(
    "should keep the exact logical ID inventory (REPLACE/DELETE guard)",
    () => {
      expect(logicalIds(synth())).toMatchSnapshot();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep the complete CfnOutputs surface",
    () => {
      expect(sortByKey(synth().findOutputs("*"))).toMatchSnapshot();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep every Lambda function's environment variables",
    () => {
      expect(lambdaEnvironments(synth())).toMatchSnapshot();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep every IAM role and policy document",
    () => {
      expect(iamSurface(synth())).toMatchSnapshot();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep every Lambda function's wiring (role binding, handler, runtime, sizing)",
    () => {
      expect(lambdaWiring(synth())).toMatchSnapshot();
    },
    SYNTH_TIMEOUT_MS,
  );
});
