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

  it("tenant lifecycle scripts は CDK を bun で実行すべき", () => {
    expect(readRepoFile("scripts/provision-tenant.sh")).toContain(
      'bun cdk deploy "$STACK_NAME" --require-approval never',
    );
    // update-tenant.sh は `${STACK_NAME}` (braces) で wait_for_stack_idle と一致させている。
    // 形が違う provision-tenant / deprovision-tenant は他で test 済。
    expect(readRepoFile("scripts/update-tenant.sh")).toMatch(
      /bun cdk deploy "\$\{?STACK_NAME\}?" --exclusively --require-approval never/,
    );
    expect(readRepoFile("scripts/deprovision-tenant.sh")).toContain(
      'bun cdk destroy "$STACK_NAME" --force',
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

  // Issue #1053: hosting を ProblemDeployBackendStack に移管したため、 update-tenant.sh / provision-tenant.sh
  // は `CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL` を env で渡さない (= cross-stack ref に置換)。
  // 旧 env-var 経路が誤って復活しないよう regression pin する。
  it("update-tenant.sh は CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL を env-var inject しないべき (#1053)", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).not.toMatch(/export\s+CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL=/);
  });

  // Issue #1038 P2 #13: SBT pipeline (CodeBuild) が pooled / silo stack を synth するとき
  // `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true` を持っていないと、 `enableParticipantPortal=false`
  // に倒れて `problemDeployBackendStack.participantPortalUrl` が undefined になり、 pooled
  // stack の runtime-config に `participantPortalUrl` が **silent に消える**。 install.sh と
  // 同じ default を CodeBuild にも入れて regression を防ぐ。
  it("update-tenant.sh は CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true を export すべき", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
  });

  it("provision-tenant.sh は CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true を export すべき", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
  });

  it("install.sh も CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true を export すべき (= 3 script 同期)", () => {
    const script = readRepoFile("scripts/install.sh");
    expect(script).toMatch(/export\s+CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=["']true["']/);
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

  // SBT の Step Functions provisioning は pooled stack へ並列 deploy を試みるため、
  // cdk deploy 前に stack を idle まで poll しないと次の 2 種で fail する:
  //   1. Cannot delete ChangeSet in status CREATE_IN_PROGRESS
  //   2. Stack ... is in UPDATE_IN_PROGRESS state and can not be updated
  // 実 deploy 環境 (2026-05-18 CodeBuild logs) で 3 連続 fail を観測したので regression
  // pin する。
  it("update-tenant.sh は cdk deploy 直前に wait_for_stack_idle で stack を poll すべき", () => {
    const script = readRepoFile("scripts/update-tenant.sh");
    expect(script).toContain("wait_for_stack_idle()");
    expect(script).toContain('wait_for_stack_idle "${STACK_NAME}"');
    // poll は cdk deploy より **前** に呼ばれていること (= race を防ぐ順序)
    const waitIdx = script.indexOf('wait_for_stack_idle "${STACK_NAME}"');
    const deployIdx = script.indexOf("bun cdk deploy");
    expect(waitIdx).toBeGreaterThan(0);
    expect(deployIdx).toBeGreaterThan(waitIdx);
  });

  // Issue #1029 follow-up: tier は admin-console から大文字 / 小文字どちらでも渡ってくる
  // 可能性がある。 provision-tenant.sh が `[[ $TIER == "PLATINUM" ]]` で大文字比較する前に
  // 必ず uppercase 正規化する。 忘れると小文字 "platinum" が silo 分岐に入らず pooled に
  // 倒れて UI で「Open ↗ (pooled)」 表示になる (= 2026-05-18 testsilo regression)。
  it("provision-tenant.sh は TIER を大文字に正規化してから PLATINUM 判定すべき", () => {
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
  it("provision-tenant.sh は CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL を env-var inject しないべき (#1053)", () => {
    const script = readRepoFile("scripts/provision-tenant.sh");
    expect(script).not.toMatch(/export\s+CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL=/);
  });
});
