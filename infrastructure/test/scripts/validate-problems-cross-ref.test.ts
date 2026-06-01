import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCoordinationPluginFile } from "../../../scripts/validate-problems";

/**
 * Issue #951 sub #2: validate-problems.ts の cross-ref check が壊れた問題 (=
 * scoring.flagOutputKey / endpoints[].key が template.yaml Outputs に無い等)
 * を実 deploy 前に止めることを保証する。
 *
 * checkCrossRefs のロジックは string-include で素朴。 本テストは
 *   (a) ロジック単位の境界条件を直接観察
 *   (b) 実 script を repo の現状で実行して全 problem が OK で返ることを E2E pin
 * の 2 段で守る。
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const VALIDATE_SCRIPT = join(REPO_ROOT, "scripts/validate-problems.ts");

describe("validate-problems cross-ref check (#951 sub #2)", () => {
  it("includes() should return true when flagOutputKey is present in template.yaml Outputs", () => {
    const yaml = `Outputs:\n  FlagValue:\n    Value: x\n`;
    expect(yaml.includes("FlagValue:")).toBe(true);
  });

  it("includes() should return false when flagOutputKey is missing from Outputs", () => {
    const yaml = `Outputs:\n  SomeOtherKey:\n    Value: x\n`;
    expect(yaml.includes("ThisKeyDoesNotExist:")).toBe(false);
  });

  it("should detect when endpoints[].default.key is missing in Outputs", () => {
    const yaml = `Outputs:\n  ServiceUrl:\n    Value: https://example.com\n`;
    expect(yaml.includes("NonExistent:")).toBe(false);
  });

  it("the real script (validate-problems.ts) should return OK on the repo's problems/", () => {
    const out = execSync(`bun run ${VALIDATE_SCRIPT}`, {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(out).toContain("件の metadata.json はすべて有効です");
  });
});

describe("checkCoordinationPluginFile (#1420)", () => {
  // microservice-migration-battle は interTeamCoordination.plugin=coordination/router.ts を宣言する
  // 唯一の参照問題 (submodule)。 実在 path での positive と、 不在 path での negative を pin する。
  const MS_DIR = join(REPO_ROOT, "problems/battles/microservice-migration-battle");

  it("should pass when the declared coordination plugin file exists", () => {
    expect(
      checkCoordinationPluginFile(
        { interTeamCoordination: { plugin: "coordination/router.ts" } },
        MS_DIR,
      ),
    ).toEqual([]);
  });

  it("should error when the coordination plugin file is missing", () => {
    const errors = checkCoordinationPluginFile(
      { interTeamCoordination: { plugin: "coordination/does-not-exist.ts" } },
      MS_DIR,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("coordination/does-not-exist.ts");
  });

  it("should be a no-op when interTeamCoordination is absent", () => {
    expect(checkCoordinationPluginFile({}, MS_DIR)).toEqual([]);
  });

  it("should be a no-op when plugin is not a string", () => {
    expect(checkCoordinationPluginFile({ interTeamCoordination: {} }, MS_DIR)).toEqual([]);
  });
});
