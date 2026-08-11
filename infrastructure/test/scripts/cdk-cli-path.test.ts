import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const INFRASTRUCTURE_DIR = join(REPO_ROOT, "infrastructure");
const LOCAL_CDK = join(REPO_ROOT, "node_modules", "aws-cdk", "bin", "cdk");
const EXPECTED_MAKE_COMMAND = "cd infrastructure && JSII_DEPRECATED=quiet ../scripts/run-cdk.sh";
const CDK_SHELL_SCRIPTS = [
  "scripts/install.sh",
  "scripts/cleanup.sh",
  "scripts/provision-tenant.sh",
  "scripts/update-tenant.sh",
  "scripts/deprovision-tenant.sh",
];

interface InfrastructurePackageJson {
  readonly dependencies: {
    readonly "aws-cdk-lib": string;
  };
  readonly devDependencies: {
    readonly "@aws-cdk/cloud-assembly-schema": string;
    readonly "aws-cdk": string;
  };
}

function makeDryRun(target: string): string {
  const result = spawnSync("make", ["--dry-run", target], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(result.status, `${target}: ${result.stderr}`).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe("repository-local CDK CLI contract", () => {
  it("should install the exact CLI version declared by infrastructure", () => {
    const packageJson = JSON.parse(
      readFileSync(join(INFRASTRUCTURE_DIR, "package.json"), "utf8"),
    ) as InfrastructurePackageJson;
    const result = spawnSync(LOCAL_CDK, ["--version"], {
      cwd: INFRASTRUCTURE_DIR,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split(" ")[0]).toBe(packageJson.devDependencies["aws-cdk"]);
  });

  it("should pin the framework schema to a CLI-compatible release", () => {
    const packageJson = JSON.parse(
      readFileSync(join(INFRASTRUCTURE_DIR, "package.json"), "utf8"),
    ) as InfrastructurePackageJson;
    const schemaCliVersion = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "node_modules", "@aws-cdk", "cloud-assembly-schema", "cli-version.json"),
        "utf8",
      ),
    ) as { readonly version: string };

    expect(packageJson.dependencies["aws-cdk-lib"]).not.toMatch(/^[~^]/);
    expect(packageJson.devDependencies["@aws-cdk/cloud-assembly-schema"]).not.toMatch(/^[~^]/);
    expect(packageJson.devDependencies["aws-cdk"]).toBe(schemaCliVersion.version);
  });

  it("should route package and deployment scripts through the repository-local CLI", () => {
    const packageJson = JSON.parse(
      readFileSync(join(INFRASTRUCTURE_DIR, "package.json"), "utf8"),
    ) as InfrastructurePackageJson & {
      readonly scripts: Record<string, string>;
    };

    expect(packageJson.scripts.cdk).toBe("../scripts/run-cdk.sh");
    expect(packageJson.scripts.synth).toContain("../scripts/run-cdk.sh synth");

    const runner = readFileSync(join(REPO_ROOT, "scripts", "run-cdk.sh"), "utf8");
    expect(runner).toContain("$" + "{SCRIPT_DIR}/../node_modules/aws-cdk/bin/cdk");
    expect(runner).toContain("$" + "{SCRIPT_DIR}/../cdk/node_modules/aws-cdk/bin/cdk");
    expect(runner).not.toContain("$" + "{PWD}");

    for (const scriptPath of CDK_SHELL_SCRIPTS) {
      const source = readFileSync(join(REPO_ROOT, scriptPath), "utf8");
      expect(source, scriptPath).not.toMatch(/\bbun cdk\b/);
      expect(source, scriptPath).toMatch(/\bbun run cdk -- (?:bootstrap|deploy|destroy)\b/);
    }

    const tenantPipeline = readFileSync(
      join(INFRASTRUCTURE_DIR, "lib", "tenant-pipeline", "serverless-saas-pipeline.ts"),
      "utf8",
    );
    expect(tenantPipeline).not.toContain("npm install -g aws-cdk");
  });

  it("should not export a bare CDK variable that the CLI parses as an empty option", () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

    expect(makefile).toContain("REPO_CDK :=");
    expect(makefile).not.toMatch(/^CDK\s*[:+?]?=/mu);
  });

  it.each([
    "synth",
    "check-synth",
    "deploy-always-on-runtime-role",
    "synth-always-on-runtime-role",
    "destroy-always-on-runtime-role",
    "deploy-always-on-command",
    "synth-always-on-command",
    "destroy-always-on-command",
    "deploy-always-on-runtime",
    "synth-always-on-runtime",
    "destroy-always-on-runtime",
  ])("should route make %s through the repository-local CLI", (target) => {
    expect(makeDryRun(target)).toContain(EXPECTED_MAKE_COMMAND);
  });

  it.each([
    "synth",
    "check-synth",
    "synth-always-on-runtime-role",
    "synth-always-on-command",
    "synth-always-on-runtime",
  ])("should not pass the removed --all option to make %s", (target) => {
    expect(makeDryRun(target)).not.toMatch(/\bcdk synth\b[^\n]*\s--all(?:\s|$)/);
  });

  it.each([
    ["synth-always-on-runtime-role", "bin/tenkacloud-always-on-oidc.ts"],
    ["synth-always-on-command", "bin/tenkacloud-always-on-command.ts"],
    ["synth-always-on-runtime", "bin/tenkacloud-always-on-runtime.ts"],
  ])("should run make %s through its dedicated CDK entrypoint", (target, entrypoint) => {
    expect(makeDryRun(target)).toContain(`--app "bunx tsx ${entrypoint}"`);
  });
});
