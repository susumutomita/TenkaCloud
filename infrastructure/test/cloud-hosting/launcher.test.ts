import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-launcher-"));
const app = new App({ outdir: join(directory, "cdk.out") });
const stack = new Stack(app, "CloudLauncher");
new CfnInclude(stack, "Launcher", {
  templateFile: resolve(import.meta.dirname, "../../templates/cloud-hosting-pipeline.yaml"),
});
const template = Template.fromStack(stack);
const source = z
  .object({ Properties: z.object({ Source: z.object({ BuildSpec: z.string() }) }) })
  .parse(template.findResources("AWS::CodeBuild::Project").CodeBuildProject);
const buildSpec = z
  .object({
    phases: z.object({
      install: z.object({
        commands: z.array(z.string()),
        "runtime-versions": z.object({ nodejs: z.number() }),
      }),
      build: z.object({ commands: z.array(z.string()) }),
    }),
  })
  .parse(JSON.parse(source.Properties.Source.BuildSpec));
const install = buildSpec.phases.install.commands.join("\n");
const build = buildSpec.phases.build.commands.join("\n");
const PLATFORM = "a".repeat(40);
const CATALOG = "b".repeat(40);
const POLICY = "arn:aws:iam::123456789012:policy/tenkacloud/cloud-hosting/reviewed";
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** Executes the actual template shell with every external tool replaced by a synthetic stub. */
function runPhases(overrides: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(directory, "build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls");
  writeFileSync(log, "");
  const stub = `#!/bin/bash
set -eu
command="$(basename "$0")"
printf '%s|%s|runner=%s|policy=%s\\n' "$command" "$*" "\${TENKACLOUD_RUNNER_BINDINGS-unset}" "\${TENKACLOUD_CFN_EXECUTION_POLICY_ARN-unset}" >> "$CALL_LOG"
case "$command:$*" in
  'git:init --quiet '*) mkdir -p "$CODEBUILD_SRC_DIR/repo/scripts/cloud-hosting"; touch "$CODEBUILD_SRC_DIR/repo/scripts/cloud-hosting/main.ts" ;;
  'git:-c protocol.file.allow=never fetch '*) [ "\${FAIL_FETCH:-0}" = 0 ] ;;
  'git:rev-parse --verify '*) printf '%s\\n' "\${RESOLVED_PLATFORM:-$REPO_REF}" ;;
  'git:ls-tree HEAD problems') printf '160000 commit %s\\tproblems\\n' "$CATALOG" ;;
  'git:-C problems rev-parse HEAD') printf '%s\\n' "\${RESOLVED_CATALOG:-$CATALOG}" ;;
  'npm:root --global') printf '%s\\n' "$CODEBUILD_SRC_DIR/npm" ;;
  'bun:--version') printf '%s\\n' "\${BUN_VERSION:-1.3.11}" ;;
  'bun:run scripts/cloud-hosting/main.ts up') exit "\${CLI_EXIT:-0}" ;;
  aws:*) echo 'No AWS operation is permitted by this test.' >&2; exit 99 ;;
esac
`;
  for (const name of ["git", "npm", "bun", "aws"]) {
    const file = join(bin, name);
    writeFileSync(file, stub);
    chmodSync(file, 0o700);
  }
  const result = spawnSync("/bin/bash", ["-c", `${install}\n${build}`], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CODEBUILD_SRC_DIR: root,
      CALL_LOG: log,
      CATALOG,
      REPO_URL: "https://github.com/susumutomita/TenkaCloud.git",
      REPO_REF: PLATFORM,
      AWS_DEFAULT_REGION: "us-east-1",
      TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
      TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY,
      TENKACLOUD_RUNNER_BINDINGS: "",
      ...overrides,
    },
  });
  return { ...result, calls: readFileSync(log, "utf8") };
}

describe("current-cloud CodeBuild onboarding source contract; no AWS execution", () => {
  it("restores the launcher without creating IAM grants or automatically starting a build", () => {
    template.resourceCountIs("AWS::CodeBuild::Project", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
    expect(buildSpec.phases.install["runtime-versions"].nodejs).toBe(24);
    expect(Object.keys(template.findResources("AWS::IAM::Role"))).toHaveLength(0);
    expect(Object.keys(template.findResources("AWS::IAM::Policy"))).toHaveLength(0);
    expect(Object.keys(template.findResources("AWS::CloudFormation::CustomResource"))).toHaveLength(
      0,
    );
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      ServiceRole: { Ref: "CodeBuildServiceRoleArn" },
      ConcurrentBuildLimit: 1,
      Environment: { PrivilegedMode: false },
    });
    template.hasParameter("RepoRef", { Type: "String", AllowedPattern: "^[a-f0-9]{40}$" });
    const parsed = z
      .object({ Parameters: z.record(z.record(z.unknown())) })
      .parse(template.toJSON());
    for (const name of ["RepoRef", "CodeBuildServiceRoleArn", "CloudFormationExecutionPolicyArn"])
      expect(parsed.Parameters[name]).not.toHaveProperty("Default");
    expect(source.Properties.Source.BuildSpec).not.toMatch(
      /cdk bootstrap|AdministratorAccess|destroy-all|TURSO/u,
    );
  });
  it("checks out the exact source and catalog, installs without hooks, and calls the shared guarded CLI", () => {
    const result = runPhases();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`fetch --depth 1 origin ${PLATFORM}`);
    expect(result.calls).toContain("submodule update --init --recursive problems");
    expect(result.calls).toContain(
      "npm|install --global --ignore-scripts @oven/bun-linux-x64@1.3.11",
    );
    expect(result.calls).toContain("bun|install --frozen-lockfile --ignore-scripts");
    expect(result.calls).toContain(
      `bun|run scripts/cloud-hosting/main.ts up|runner=unset|policy=${POLICY}`,
    );
    expect(result.calls).not.toContain("aws|");
  });
  it("preserves explicitly reviewed runner bindings instead of silently deleting an existing runner", () => {
    const bindings = '[{"id":"reviewed-synthetic-binding"}]';
    const result = runPhases({ TENKACLOUD_RUNNER_BINDINGS: bindings });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`bun|run scripts/cloud-hosting/main.ts up|runner=${bindings}`);
  });
  it.each([
    { REPO_REF: "main" },
    { REPO_REF: "$(touch /tmp/unexpected)" },
    { REPO_URL: "file:///unrelated" },
    { FAIL_FETCH: "1" },
    { RESOLVED_PLATFORM: "c".repeat(40) },
    { RESOLVED_CATALOG: "c".repeat(40) },
    { BUN_VERSION: "unexpected" },
  ])("refuses source or toolchain drift without invoking cloud deployment: %j", (overrides) => {
    const result = runPhases(overrides);
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain("bun|run scripts/cloud-hosting/main.ts up");
  });
  it("propagates a failed CLI deployment instead of reporting success", () => {
    expect(runPhases({ CLI_EXIT: "17" }).status).toBe(17);
  });
});
