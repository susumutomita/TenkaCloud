import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #1031: `scripts/install.sh` は admin-console-hosting を cross-stack ref で先に立てる
 * 構造へ refactor し、 旧 Phase 1/2/3 を `cdk deploy --all` 1 発に統合した。 本 file は
 *   - 単一 deploy 文 1 つで全 stack を立てる
 *   - 旧 env-var injection (CDK_PARAM_ADMIN_CONSOLE_ORIGIN) を行わない
 *   - DRY (= prepare-source-bundle.sh への委譲) を保つ
 *   - pooled stack を直 deploy しない (= SBT pipeline 一本化、 Issue #1029)
 * を pin する。
 */

const INSTALL_SH_PATH = join(__dirname, "..", "..", "scripts", "install.sh");
const PREPARE_BUNDLE_SH_PATH = join(__dirname, "..", "..", "scripts", "prepare-source-bundle.sh");

describe("scripts/install.sh (Issue #1031: single-phase deploy)", () => {
  const source = readFileSync(INSTALL_SH_PATH, "utf8");
  const prepareBundle = readFileSync(PREPARE_BUNDLE_SH_PATH, "utf8");

  it("should deploy all stacks in one shot via `bun cdk deploy --all` (#1031)", () => {
    // bash の \ 継続を許容するため、 `--all` と `--require-approval never` を別 line 検査で。
    expect(source).toMatch(/bun cdk deploy --all\b/);
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

  // prepare-source-bundle.sh が staging logic の DRY 集約点であることを pin。
  it("prepare-source-bundle.sh should copy the repo root `package.json` to the staging root", () => {
    expect(prepareBundle).toContain('cp package.json "${STAGING}/package.json"');
  });

  it("prepare-source-bundle.sh should copy the `packages` directory to the staging root (workspace:* protocol)", () => {
    expect(prepareBundle).toContain('cp -R packages "${STAGING}/packages"');
  });

  it("prepare-source-bundle.sh should rewrite staging package.json workspaces from `infrastructure` to `cdk`", () => {
    expect(prepareBundle).toContain("pkg['workspaces'] = [w if w != 'infrastructure' else 'cdk'");
  });

  it("install.sh should source prepare-source-bundle.sh and delegate staging without inlining duplicates", () => {
    expect(source).toContain('source "${SCRIPT_DIR}/prepare-source-bundle.sh"');
    expect(source).not.toContain('cp -R packages "${STAGING}/packages"');
    expect(source).not.toContain('cp -R problems "${STAGING}/problems"');
  });

  // Issue #1029 / PR-1028: pooled stack の lifecycle は SBT pipeline 一本化。
  it("install.sh should not cdk deploy tenkacloud-tenant-template-pooled (SBT pipeline consolidation)", () => {
    // `bun cdk deploy --all` は `--exclusively` で all を意味するため、 pooled stack を **直接
    // 名指しで deploy しない** ことのみ pin する。 `--all` は app 上 instantiate された stack を
    // 全て deploy するため、 wire.ts で pooled stack を生成する限り CDK が立てに行く。 pooled
    // stack の SBT pipeline 一本化は wire.ts 側 + `--exclusively` flag で扱う方針。
    expect(source).not.toMatch(/bun cdk deploy[^\n-][^\n]*tenkacloud-tenant-template-pooled/);
  });

  it("install.sh repo-root variable should be unified to **all-uppercase** TENKACLOUD_ROOT (no PascalCase)", () => {
    expect(source).not.toMatch(/\$\{TenkaCloud_ROOT[}:]/);
    expect(source).not.toMatch(/\$\{TenkaCloud_Root[}:]/);
    expect(source).toMatch(/\$\{TENKACLOUD_ROOT[}:]/);
  });
});
