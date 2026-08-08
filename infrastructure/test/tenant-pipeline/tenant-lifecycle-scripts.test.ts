import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { composeTenantScript } from "../../lib/bootstrap-template/compose-tenant-script";

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

  // Regression: a platinum (silo) tenant was registered as "Complete" with every endpoint
  // empty. CodeBuild inlines these scripts into the buildspec and runs each as ONE command
  // block in an already-running shell, so `#!/bin/bash -e` is parsed as a comment and `set -e`
  // never takes effect — the block's exit status is that of its last statement
  // (`export tenantStatus="Complete"`). `cdk deploy` failed, four `describe-stacks` calls
  // failed, two Cognito calls failed, and CodeBuild still reported BUILD SUCCEEDED.
  // The flags must therefore be real statements, not shebang arguments.
  it("tenant lifecycle scripts should enable errexit as a statement, not via the shebang", () => {
    for (const scriptPath of lifecycleScripts) {
      const script = readRepoFile(scriptPath);
      const [shebang = ""] = script.split("\n");

      // CodeBuild ignores the shebang, so flags carried there are silently inert.
      expect(shebang, `${scriptPath} carries flags on its shebang`).toBe("#!/bin/bash");
      expect(script, `${scriptPath} never sets errexit`).toMatch(/^set -e$/m);
      expect(script, `${scriptPath} never sets pipefail`).toMatch(/^set -o pipefail$/m);
    }
  });

  // `describe-stacks --query ... --output text` returns an EMPTY string with exit 0 when the
  // stack exists but the OutputKey does not, so errexit alone cannot catch it. Without an
  // explicit check the empty values flow straight into the tenantConfig write-back.
  it("provision-tenant.sh should refuse to complete on an empty stack output", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");

    expect(script).toContain("require_stack_output()");
    for (const outputVar of [
      "$USER_POOL_OUTPUT_PARAM_NAME",
      "$APP_CLIENT_ID_OUTPUT_PARAM_NAME",
      "$API_GATEWAY_URL_OUTPUT_PARAM_NAME",
      "$APPLICATION_ADMIN_CONSOLE_URL_OUTPUT_PARAM_NAME",
    ]) {
      expect(script, `${outputVar} is not validated`).toContain(
        `require_stack_output "${outputVar}"`,
      );
    }
    // The guard has to run before the status write-back, or it guards nothing. Anchor to the
    // start of a line so the prose in the header comment is not mistaken for the statement.
    const firstGuardAt = script.search(/^require_stack_output "\$USER_POOL_OUTPUT_PARAM_NAME"/m);
    const statusWriteBackAt = script.search(/^export tenantStatus="Complete"$/m);

    expect(firstGuardAt).toBeGreaterThanOrEqual(0);
    expect(statusWriteBackAt).toBeGreaterThanOrEqual(0);
    expect(firstGuardAt).toBeLessThan(statusWriteBackAt);
  });

  // The silo deploy died Docker-building ControlPlaneStack's Python Lambda — a stack it was not
  // deploying — because synth constructs the whole app. Bundling must be scoped to the stack
  // being deployed, and that scoping is only safe together with `--exclusively`: without it,
  // dependency stacks join the deployment set carrying stub assets.
  it("cdk deploy from CodeBuild should scope bundling and deploy exclusively", () => {
    for (const scriptPath of ["scripts/provision-tenant.sh", "scripts/update-tenant.sh"]) {
      const script = readRepoFile(scriptPath);

      expect(script, `${scriptPath} does not scope bundling`).toMatch(
        /^\s*export CDK_BUNDLING_STACKS="\$\{?STACK_NAME\}?"$/m,
      );
      // Every cdk deploy in these scripts must carry --exclusively.
      const deployLines = script
        .split("\n")
        .filter((line) => line.includes("bun run cdk -- deploy"));
      expect(deployLines.length, `${scriptPath} has no cdk deploy`).toBeGreaterThan(0);
      for (const line of deployLines) {
        expect(line, `${scriptPath}: scoped bundling without --exclusively`).toContain(
          "--exclusively",
        );
      }
    }
  });

  // Regression: with errexit finally active, `pip install --upgrade setuptools` aborted every
  // provisioning run before it reached `cdk deploy` — CodeBuild's base image has setuptools under
  // rpm, so the uninstall step fails with "RECORD file not found". It had been failing silently
  // for as long as the shebang swallowed it. `--ignore-installed` skips the uninstall so the step
  // actually succeeds; suppressing the failure instead would walk straight back into the original
  // defect.
  it("should install setuptools without the uninstall step rpm makes impossible", () => {
    for (const scriptPath of ["scripts/provision-tenant.sh", "scripts/deprovision-tenant.sh"]) {
      const script = readRepoFile(scriptPath);
      const setuptoolsLines = script
        .split("\n")
        .filter((line) => line.includes("pip install") && line.includes("setuptools"));

      expect(setuptoolsLines.length, `${scriptPath} no longer installs setuptools`).toBe(1);
      expect(setuptoolsLines[0], `${scriptPath} would hit the rpm uninstall failure`).toContain(
        "--ignore-installed",
      );
      // Suppressing the failure would restore the silent-success defect this all started from.
      expect(setuptoolsLines[0], `${scriptPath} swallows the failure`).not.toMatch(/\|\|\s*true/);
    }
  });

  it("tenant lifecycle scripts should not use the legacy package runner", () => {
    const legacyPackageRunnerPattern = new RegExp(`\\b${"np"}x\\b`);

    for (const scriptPath of lifecycleScripts) {
      expect(readRepoFile(scriptPath)).not.toMatch(legacyPackageRunnerPattern);
    }
  });

  it("tenant lifecycle scripts should run the repository-local CDK CLI via bun", () => {
    expect(readRepoFile("scripts/provision-tenant.sh")).toContain(
      'bun run cdk -- deploy "$STACK_NAME" --exclusively --require-approval never',
    );
    // update-tenant.sh は `${STACK_NAME}` (braces) で wait_for_stack_idle と一致させている。
    // 形が違う provision-tenant / deprovision-tenant は他で test 済。
    expect(readRepoFile("scripts/update-tenant.sh")).toMatch(
      /bun run cdk -- deploy "\$\{?STACK_NAME\}?" --exclusively --require-approval never/,
    );
    expect(readRepoFile("scripts/deprovision-tenant.sh")).toContain(
      'bun run cdk -- destroy "$STACK_NAME" --force',
    );
  });

  it("CodeBuild runtime helper should install the packageManager's Bun", () => {
    const helper = readRepoFile("scripts/lib/install-node.sh");

    expect(helper).toContain("packageManager");
    expect(helper).toContain("bun --version");
    expect(helper).toContain("install_bun_from_package_manager");
  });

  it("deprovision script should unpack source.zip before sourcing the runtime helper", () => {
    // #2217: the fetch/unzip preamble now lives in scripts/lib/fetch-source-bundle.sh
    // and is inlined at synth by composeTenantScript. Assert the ordering invariant
    // on the COMPOSED script (what actually runs), not the raw marker-bearing file.
    const script = composeTenantScript(resolve(REPO_ROOT, "scripts/deprovision-tenant.sh"));
    const unzipIndex = script.indexOf('unzip -o "$CDK_SOURCE_NAME"');
    const sourceIndex = script.indexOf("source ./scripts/lib/install-node.sh");

    expect(unzipIndex).toBeGreaterThan(0);
    expect(sourceIndex).toBeGreaterThan(unzipIndex);
  });

  it("deprovision script should destroy from the bundled TenkaCloud CDK workspace", () => {
    const script = readRepoFile("scripts/deprovision-tenant.sh");

    expect(script).toContain("cd cdk\n  bun install");
    expect(script).not.toContain("aws-saas-factory-ref-solution-serverless-saas");
    expect(script).not.toMatch(/\bnpm install\b/);
  });

  it("should pin .nvmrc to Node 22 or higher", () => {
    const nodeMajor = Number.parseInt(
      readRepoFile(".nvmrc").trim().replace(/^v/, "").split(".")[0] ?? "",
      10,
    );

    expect(nodeMajor).toBeGreaterThanOrEqual(22);
  });

  // Issue #1053: hosting を ProblemDeployBackendStack に移管したため、 update-tenant.sh / provision-tenant.sh
  // は `CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL` を env で渡さない (= cross-stack ref に置換)。
  // 旧 env-var 経路が誤って復活しないよう regression pin する。
  it("update-tenant.sh should not env-var inject CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL (#1053)", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).not.toMatch(/export\s+CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL=/);
  });

  // Issue #1038 P2 #13: SBT pipeline (CodeBuild) が pooled / silo stack を synth するとき
  // `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true` を持っていないと、 `enableParticipantPortal=false`
  // に倒れて `problemDeployBackendStack.participantPortalUrl` が undefined になり、 pooled
  // stack の runtime-config に `participantPortalUrl` が **silent に消える**。 install.sh と
  // 同じ default を CodeBuild にも入れて regression を防ぐ。
  it("update-tenant.sh should export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
  });

  it("provision-tenant.sh should export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
  });

  it("install.sh should also export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true (3-script sync)", () => {
    const script = readRepoFile("scripts/install.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
  });

  it("mise Node/Bun runtimes should match the repo's canonical versions", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager?: string;
    };
    const bunVersion = packageJson.packageManager?.replace(/^bun@/, "");
    const nodeMajor = readRepoFile(".nvmrc").trim().replace(/^v/, "").split(".")[0];
    const miseToml = readRepoFile("mise.toml");

    expect(miseToml).toContain(`node = "${nodeMajor}"`);
    expect(miseToml).toContain(`bun = "${bunVersion}"`);
  });

  // SBT の Step Functions provisioning は pooled stack へ並列 deploy を試みるため、
  // cdk deploy 前に stack を idle まで poll しないと次の 2 種で fail する:
  //   1. Cannot delete ChangeSet in status CREATE_IN_PROGRESS
  //   2. Stack ... is in UPDATE_IN_PROGRESS state and can not be updated
  // 実 deploy 環境 (2026-05-18 CodeBuild logs) で 3 連続 fail を観測したので regression
  // pin する。
  it("update-tenant.sh should poll the stack via wait_for_stack_idle right before cdk deploy", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).toContain("wait_for_stack_idle()");
    expect(script).toContain(`wait_for_stack_idle "\${STACK_NAME}"`);
    // poll は cdk deploy より **前** に呼ばれていること (= race を防ぐ順序)
    const waitIdx = script.indexOf(`wait_for_stack_idle "\${STACK_NAME}"`);
    const deployIdx = script.indexOf("bun run cdk -- deploy");
    expect(waitIdx).toBeGreaterThan(0);
    expect(deployIdx).toBeGreaterThan(waitIdx);
  });

  // Issue #1029 follow-up: tier は admin-console から大文字 / 小文字どちらでも渡ってくる
  // 可能性がある。 provision-tenant.sh が `[[ $TIER == "PLATINUM" ]]` で大文字比較する前に
  // 必ず uppercase 正規化する。 忘れると小文字 "platinum" が silo 分岐に入らず pooled に
  // 倒れて UI で「Open ↗ (pooled)」 表示になる (= 2026-05-18 testsilo regression)。
  it("provision-tenant.sh should normalize TIER to uppercase before judging PLATINUM", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");
    // TIER 環境変数が tr で大文字化されてから export されること
    expect(script).toMatch(/export TIER=\$\(echo "\$tier" \| tr '\[:lower:\]' '\[:upper:\]'\)/);
    // 比較は大文字 PLATINUM (= 正規化後の形)
    expect(script).toContain('[[ $TIER == "PLATINUM" ]]');
    // 正規化 (= tr) は **silo 分岐の `if [[ $TIER == "PLATINUM" ]]; then` を含む block** より
    // 前に来ること。 docblock 内の参照と区別するため、 `if [[` を伴う block 開始行で比較する。
    const normalizeIdx = script.indexOf("tr '[:lower:]' '[:upper:]'");
    const branchIdx = script.indexOf('if [[ $TIER == "PLATINUM" ]]; then');
    expect(normalizeIdx).toBeGreaterThan(0);
    expect(branchIdx).toBeGreaterThan(normalizeIdx);
  });

  // Issue #1053: 初回 provisioning でも env-var inject は不要 (= ProblemDeployBackendStack
  // から cross-stack ref で URL が引かれる)。 旧経路が誤って復活しないよう regression pin。
  it("provision-tenant.sh should not env-var inject CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL (#1053)", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");
    expect(script).not.toMatch(/export\s+CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL=/);
  });
});
