import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { architectureRules } from "./index.ts";

/**
 * レジストリ drift の構造ガード (PR-1806 レビュー指摘の再発防止)。
 *
 * 旧実装は cli.ts が独自の ALL_RULES を複製しており、rules/index.ts に登録しただけの
 * ルール (no-conflict-markers / no-aws-trademark-fictions / 新規 2 ルール) が CLI から
 * 実行されない「死んだルール」を生んでいた。cli.ts は architectureRules を直接 consume
 * する構成に変更済みで、本テストは「rules/ 配下に実装した Rule は必ず architectureRules
 * に登録されている」ことをファイルシステム駆動で固定する (= 登録漏れは即 red)。
 */
describe("architecture rules registry completeness", () => {
  it("should register every rule implemented under rules/ in architectureRules", async () => {
    const dir = join(import.meta.dirname, ".");
    const ruleFiles = readdirSync(dir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "index.ts" &&
        f !== "registry-completeness.test.ts",
    );
    const registeredIds = new Set(architectureRules.map((r) => r.id));
    const missing: string[] = [];
    for (const file of ruleFiles) {
      const mod = (await import(`./${file}`)) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        const maybeRule = value as { id?: unknown; check?: unknown };
        if (typeof maybeRule?.id === "string" && typeof maybeRule?.check === "function") {
          if (!registeredIds.has(maybeRule.id)) missing.push(`${file} -> ${maybeRule.id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
