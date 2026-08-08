import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #1031: `scripts/install.sh` は admin-console-hosting を cross-stack ref で先に立てる
 * 構造へ refactor し、 旧 Phase 1/2/3 を `cdk deploy --all` 1 発に統合した。 本 file は
 *   - 単一 deploy 文 1 つで全 stack を立てる
 *   - 旧 env-var injection (CDK_PARAM_ADMIN_CONSOLE_ORIGIN) を行わない
 *   - DRY (= prepare-source-bundle.sh への委譲) を保つ
 *   - stack 名を名指しした deploy 行を復活させない (= 単一 deploy 文を保つ)
 * を pin する。
 */

const INSTALL_SH_PATH = join(__dirname, "..", "..", "scripts", "install.sh");
const PREPARE_BUNDLE_SH_PATH = join(__dirname, "..", "..", "scripts", "prepare-source-bundle.sh");
const PACKAGE_BUNDLE_SH_PATH = join(__dirname, "..", "..", "scripts", "package-source-bundle.sh");

describe("scripts/install.sh (Issue #1031: single-phase deploy)", () => {
  const source = readFileSync(INSTALL_SH_PATH, "utf8");
  const prepareBundle = readFileSync(PREPARE_BUNDLE_SH_PATH, "utf8");
  const packageBundle = readFileSync(PACKAGE_BUNDLE_SH_PATH, "utf8");

  it("should deploy all stacks in one shot via the repository-local CDK CLI (#1031)", () => {
    // bash の \ 継続を許容するため、 `--all` と `--require-approval never` を別 line 検査で。
    expect(source).toMatch(/bun run cdk -- deploy --all\b/);
    expect(source).toContain("--require-approval never");
  });

  it("should retire the legacy Phase 3 `CDK_PARAM_ADMIN_CONSOLE_ORIGIN` env injection (#1031)", () => {
    expect(source).not.toContain("export CDK_PARAM_ADMIN_CONSOLE_ORIGIN=");
  });

  it("should retire legacy backend-output env vars read in old Phase 2 (CDK_PARAM_CONTROL_PLANE_API_URL etc.) (#1031)", () => {
    expect(source).not.toContain("CDK_PARAM_CONTROL_PLANE_API_URL");
    expect(source).not.toContain("CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN");
    expect(source).not.toContain("CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID");
    expect(source).not.toContain("CDK_PARAM_POOLED_APP_CONSOLE_URL");
    expect(source).not.toContain("CDK_PARAM_PROVISIONING_CODEBUILD_PROJECT");
    expect(source).not.toContain("CDK_PARAM_ADMIN_INSIGHT_API_URL");
  });

  // package-source-bundle.sh が local packaging logic の DRY 集約点であることを pin。
  it("prepare-source-bundle.sh should delegate local packaging to the AWS-free helper", () => {
    expect(prepareBundle).toContain(`bash "\${SCRIPT_DIR}/package-source-bundle.sh"`);
  });

  it("package-source-bundle.sh should copy the `packages` directory to the staging root (workspace:* protocol)", () => {
    // Issue: prepare-source-bundle hang on re-run — switched from `cp -R` to `rsync -a` with
    // source-side excludes (node_modules / cdk.out* / dist) to avoid copy-then-delete pattern.
    expect(packageBundle).toContain(`copy_tree "packages" "packages"`);
  });

  it("package-source-bundle.sh should exclude every CDK output directory from staging", () => {
    expect(packageBundle).toContain("--exclude='cdk.out*'");
  });

  it("package-source-bundle.sh should rewrite staging package.json workspaces from `infrastructure` to `cdk`", () => {
    expect(packageBundle).toContain('workspace if workspace != "infrastructure" else "cdk"');
  });

  it("install.sh should source prepare-source-bundle.sh and delegate staging without inlining duplicates", () => {
    expect(source).toContain(`source "\${SCRIPT_DIR}/prepare-source-bundle.sh"`);
    expect(source).not.toContain(`cp -R packages "\${STAGING}/packages"`);
    expect(source).not.toContain(`cp -R problems "\${STAGING}/problems"`);
  });

  // Issue #1031: 単一 deploy 文を保つ (= 旧 Phase 構造の stack 名列挙に戻さない)。
  it("install.sh should not name tenkacloud-tenant-template-pooled in a cdk deploy argument list", () => {
    // 注意: 本 assertion は「pooled stack が deploy されない」ことの pin **ではない**。
    // wire.ts が pooled stack を CDK app 上に instantiate している (= `cdk list` に出る) ため、
    // 全 stack を選ぶ deploy 文はこれを含む。 `--exclusively` は選択 stack の依存を足さない
    // flag で、 全選択との併用では no-op。 ここで pin しているのは、 Issue #1029 / PR-1028 当時
    // のような **stack 名を名指しした deploy 行** を install.sh に復活させないこと。
    expect(source).not.toMatch(
      /bun run cdk -- deploy[^\n-][^\n]*tenkacloud-tenant-template-pooled/,
    );
  });

  it("install.sh repo-root variable should be unified to **all-uppercase** TENKACLOUD_ROOT (no PascalCase)", () => {
    expect(source).not.toMatch(/\$\{TenkaCloud_ROOT[}:]/);
    expect(source).not.toMatch(/\$\{TenkaCloud_Root[}:]/);
    expect(source).toMatch(/\$\{TENKACLOUD_ROOT[}:]/);
  });
});
