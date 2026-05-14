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

describe("scripts/install.sh Phase 3 (#716)", () => {
  const source = readFileSync(INSTALL_SH_PATH, "utf8");

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
});
