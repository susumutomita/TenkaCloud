import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const INFRASTRUCTURE_DIR = join(REPO_ROOT, "infrastructure");
const LOCAL_CDK = join(REPO_ROOT, "node_modules", "aws-cdk", "bin", "cdk");
const EXPECTED_MAKE_COMMAND =
  "cd infrastructure && JSII_DEPRECATED=quiet ../node_modules/aws-cdk/bin/cdk";

interface InfrastructurePackageJson {
  readonly devDependencies: {
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

  it.each([
    "synth",
    "check-synth",
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
    "synth-always-on-command",
    "synth-always-on-runtime",
  ])("should not pass the removed --all option to make %s", (target) => {
    expect(makeDryRun(target)).not.toMatch(/\bcdk synth\b[^\n]*\s--all(?:\s|$)/);
  });
});
