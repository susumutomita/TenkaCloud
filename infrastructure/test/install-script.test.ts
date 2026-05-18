import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #716: `scripts/install.sh` Phase 3 が `admin-console-insight` も再 deploy しないと、
 * 該当 stack の HTTP API CORS allow-list が Phase 1 時点 (localhost-only) のままで
 * Provisioning Jobs page が "Failed to fetch" を吐く。 本テストは Phase 3 の cdk deploy
 * 行が `tenkacloud-admin-console-insight` を含むことを pin (= 退行防止)。
 */

const INSTALL_SH_PATH = join(__dirname, "..", "..", "scripts", "install.sh");
const PREPARE_BUNDLE_SH_PATH = join(__dirname, "..", "..", "scripts", "prepare-source-bundle.sh");

describe("scripts/install.sh Phase 3 (#716)", () => {
  const source = readFileSync(INSTALL_SH_PATH, "utf8");
  // staging-related logic は prepare-source-bundle.sh に集約済 (= DRY、 install.sh と
  // tenkacloud-lite.ts cmdUp の両方が同じ shell を呼ぶ)。 staging 要件は本 file で読む。
  const prepareBundle = readFileSync(PREPARE_BUNDLE_SH_PATH, "utf8");

  it("Phase 3 の cdk deploy で control-plane と admin-console-insight の両方を指定すべき", () => {
    const phase3Match = source.match(
      /bunx cdk deploy[^\n]*tenkacloud-control-plane[^\n]*tenkacloud-admin-console-insight[^\n]*--require-approval never/,
    );
    expect(phase3Match).not.toBeNull();
  });

  it("Phase 3 で CDK_PARAM_ADMIN_CONSOLE_ORIGIN を再 export してから再 deploy すべき", () => {
    const exportIdx = source.indexOf(
      `export CDK_PARAM_ADMIN_CONSOLE_ORIGIN="\${ADMIN_CONSOLE_URL}"`,
    );
    const deployIdx = source.indexOf(
      "bunx cdk deploy tenkacloud-control-plane tenkacloud-admin-console-insight",
    );
    expect(exportIdx).toBeGreaterThan(0);
    expect(deployIdx).toBeGreaterThan(exportIdx);
  });

  // tenant provisioning / update CodeBuild job が `scripts/lib/install-node.sh:
  // install_bun_from_package_manager` で CWD/`package.json` の `packageManager` field から
  // Bun version を読む。 staging root に `package.json` を copy していないと ENOENT で
  // CodeBuild job が \"package.json not found\" で fail する (= 直近 regression)。
  // 本 logic は prepare-source-bundle.sh に集約済 (= install.sh から source される、 DRY)。
  it("prepare-source-bundle.sh が staging root に repo root `package.json` を copy すべき (= CodeBuild が packageManager を読む)", () => {
    expect(prepareBundle).toContain('cp package.json "${STAGING}/package.json"');
  });

  // Issue #916 (2 層目): `infrastructure/package.json` は `@TenkaCloud/trust-bridge:
  // workspace:*` で sibling workspace を参照する。 staging に `packages/` を同梱しないと
  // bun が workspace を resolve できず `EUNSUPPORTEDPROTOCOL` (npm) /
  // `package not found` (bun) で fail する。
  it("prepare-source-bundle.sh が staging root に `packages` directory を copy すべき (= workspace:* protocol の resolve)", () => {
    expect(prepareBundle).toContain('cp -R packages "${STAGING}/packages"');
  });

  // Issue #916 (3 層目): repo root の workspaces 配列は `infrastructure` を含むが、 staging では
  // SBT ref-arch 互換のため `cdk/` にリネームされる。 root package.json の workspaces を staging で
  // も `cdk` に書き換えないと bun が CWD=cdk を workspace member と認識せず、
  // `Workspace dependency "@TenkaCloud/trust-bridge" not found / Searched in "./*"` で fail する。
  it("prepare-source-bundle.sh が staging package.json の workspaces を `infrastructure` → `cdk` に書き換えるべき", () => {
    expect(prepareBundle).toContain("pkg['workspaces'] = [w if w != 'infrastructure' else 'cdk'");
  });

  // DRY regression 防止: install.sh が staging logic を再度 inline で持たないこと。
  it("install.sh は prepare-source-bundle.sh を source して staging を委譲し、 重複 inline 化しないべき", () => {
    expect(source).toContain('source "${SCRIPT_DIR}/prepare-source-bundle.sh"');
    expect(source).not.toContain('cp -R packages "${STAGING}/packages"');
    expect(source).not.toContain('cp -R problems "${STAGING}/problems"');
  });
});
