import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("tenant lifecycle scripts", () => {
  const lifecycleScripts = [
    "scripts/provision-tenant.sh",
    "scripts/update-tenant.sh",
    "scripts/deprovision-tenant.sh",
  ];

  it("tenant lifecycle scripts は legacy package runner を使わないべき", () => {
    const legacyPackageRunnerPattern = new RegExp(`\\b${"np"}x\\b`);

    for (const scriptPath of lifecycleScripts) {
      expect(readRepoFile(scriptPath)).not.toMatch(legacyPackageRunnerPattern);
    }
  });

  it("tenant lifecycle scripts は CDK を bunx で実行すべき", () => {
    expect(readRepoFile("scripts/provision-tenant.sh")).toContain(
      'bunx cdk deploy "$STACK_NAME" --require-approval never',
    );
    expect(readRepoFile("scripts/update-tenant.sh")).toContain(
      'bunx cdk deploy "$STACK_NAME" --exclusively --require-approval never',
    );
    expect(readRepoFile("scripts/deprovision-tenant.sh")).toContain(
      'bunx cdk destroy "$STACK_NAME" --force',
    );
  });

  it("CodeBuild runtime helper は packageManager の Bun を導入すべき", () => {
    const helper = readRepoFile("scripts/lib/install-node.sh");

    expect(helper).toContain("packageManager");
    expect(helper).toContain("bun --version");
    expect(helper).toContain("install_bun_from_package_manager");
  });

  it("deprovision script は runtime helper を source する前に source.zip を展開すべき", () => {
    const script = readRepoFile("scripts/deprovision-tenant.sh");
    const unzipIndex = script.indexOf('unzip -o "$CDK_SOURCE_NAME"');
    const sourceIndex = script.indexOf("source ./scripts/lib/install-node.sh");

    expect(unzipIndex).toBeGreaterThan(0);
    expect(sourceIndex).toBeGreaterThan(unzipIndex);
  });

  it(".nvmrc は Node 22 以上を指定すべき", () => {
    const nodeMajor = Number.parseInt(
      readRepoFile(".nvmrc").trim().replace(/^v/, "").split(".")[0] ?? "",
      10,
    );

    expect(nodeMajor).toBeGreaterThanOrEqual(22);
  });

  it("mise の Node/Bun runtime は repo の正本 version と一致すべき", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager?: string;
    };
    const bunVersion = packageJson.packageManager?.replace(/^bun@/, "");
    const nodeMajor = readRepoFile(".nvmrc").trim().replace(/^v/, "").split(".")[0];
    const miseToml = readRepoFile("mise.toml");

    expect(miseToml).toContain(`node = "${nodeMajor}"`);
    expect(miseToml).toContain(`bun = "${bunVersion}"`);
  });
});
