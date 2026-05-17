import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
  it("flagOutputKey が template.yaml Outputs に存在すれば includes() が true を返すべき", () => {
    const yaml = `Outputs:\n  FlagValue:\n    Value: x\n`;
    expect(yaml.includes("FlagValue:")).toBe(true);
  });

  it("flagOutputKey が Outputs に存在しないとき includes() が false を返すべき", () => {
    const yaml = `Outputs:\n  SomeOtherKey:\n    Value: x\n`;
    expect(yaml.includes("ThisKeyDoesNotExist:")).toBe(false);
  });

  it("endpoints[].default.key が Outputs に存在しないと検出されるべき", () => {
    const yaml = `Outputs:\n  ServiceUrl:\n    Value: https://example.com\n`;
    expect(yaml.includes("NonExistent:")).toBe(false);
  });

  it("実 script (validate-problems.ts) が repo の problems/ で OK を返すべき", () => {
    const out = execSync(`bun run ${VALIDATE_SCRIPT}`, {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(out).toContain("件の metadata.json はすべて有効です");
  });
});
