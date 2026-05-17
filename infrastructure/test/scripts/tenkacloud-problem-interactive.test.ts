import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInteractive } from "../../../scripts/tenkacloud-problem";

/**
 * Issue #954: `tenkacloud problem` の interactive scaffolding を pin する。
 *
 * 設計: `runInteractive` は `ask` / `print` を依存注入で受けるので、 scripted answer
 * 配列を返す stub を渡して flow をなぞる (= TTY を mock する必要なし)。
 *
 * 生成された scaffold は `problems/<category>/<id>/` に出る。 既存問題と衝突しないよう
 * test 用 id を unique にし、 afterEach で生成ディレクトリを片付ける。
 */

interface ScriptedPrompts {
  readonly answers: readonly string[];
  readonly output: string[];
}

function buildPrompts(answers: readonly string[]): {
  prompts: { ask: (q: string) => Promise<string>; print: (l: string) => void };
  script: ScriptedPrompts;
} {
  const script: ScriptedPrompts = { answers, output: [] };
  let cursor = 0;
  return {
    script,
    prompts: {
      ask: async (_q: string) => {
        if (cursor >= script.answers.length) {
          throw new Error(`prompt exhausted (cursor=${cursor})`);
        }
        return script.answers[cursor++] ?? "";
      },
      print: (line: string) => {
        script.output.push(line);
      },
    },
  };
}

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore — 一部だけ片付いた状態でも他 test に影響しない
    }
  }
});

describe("ADR-012 Phase 6 / #954: runInteractive scaffolding", () => {
  it("kind 番号 + ID + Enter (= category override 無し) で flag scaffold を生成するべき", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-flag`;
    const { prompts } = buildPrompts(["1", uniqueId, "", "Y"]);
    const out = join(REPO_ROOT, "problems/challenges", uniqueId);
    createdPaths.push(out);

    const { created } = await runInteractive(prompts);

    expect(created.kind).toBe("flag");
    expect(created.category).toBe("Challenge");
    expect(created.outputDir).toContain(uniqueId);
    expect(existsSync(join(created.outputDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(created.outputDir, "template.yaml"))).toBe(true);
    const metadata = JSON.parse(readFileSync(join(created.outputDir, "metadata.json"), "utf8"));
    expect(metadata.id).toBe(uniqueId);
    expect(metadata.category).toBe("Challenge");
    expect(metadata.scoring.kind).toBe("flag");
  });

  it("kind 名 (= 番号でなく文字列) でも受け付けるべき", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-uflat`;
    const { prompts } = buildPrompts(["uptime-flat", uniqueId, "", "y"]);
    createdPaths.push(join(REPO_ROOT, "problems/battles", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.kind).toBe("uptime-flat");
    expect(created.category).toBe("Battle");
  });

  it("category override (= Challenge を Battle に切替) を受け付けるべき", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-fbat`;
    const { prompts } = buildPrompts(["1", uniqueId, "Battle", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/battles", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.kind).toBe("flag");
    expect(created.category).toBe("Battle");
    expect(created.outputDir).toContain("/battles/");
    const metadata = JSON.parse(readFileSync(join(created.outputDir, "metadata.json"), "utf8"));
    expect(metadata.category).toBe("Battle");
  });

  it("無効 kind 入力 → 再 prompt → 正しい入力で進むべき", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-retry`;
    const { prompts, script } = buildPrompts(["bogus", "9", "1", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.kind).toBe("flag");
    // print 出力に拒否メッセージが残るべき (= UX 確認)
    const allOutput = script.output.join("\n");
    expect(allOutput).toContain("無効");
  });

  it("無効 problemId (= 大文字 / 短すぎ) は拒否され再 prompt されるべき", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-bad`;
    const { prompts } = buildPrompts(["1", "Bad-ID", "ab", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.outputDir).toContain(uniqueId);
  });

  it("既存 problemId は拒否され再 prompt されるべき (= hello-world は既に repo に存在)", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-dup`;
    const { prompts, script } = buildPrompts(["1", "hello-world", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.outputDir).toContain(uniqueId);
    expect(script.output.join("\n")).toContain("既に存在");
  });

  it("confirm が 'n' なら 生成せず throw すべき (= 中止)", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-abort`;
    const { prompts } = buildPrompts(["1", uniqueId, "", "n"]);

    await expect(runInteractive(prompts)).rejects.toThrow("aborted");
    // 出力ディレクトリは作られていない
    expect(existsSync(join(REPO_ROOT, "problems/challenges", uniqueId))).toBe(false);
  });
});

/**
 * tmpdir 単体テスト (= REPO 側 problems/ に副作用を持ち込まないバージョン)。
 * runCreate は repo root 直下の problems/ を出力先にしているので、 副作用テストは
 * 上記の createdPaths で片付ける方針で OK。 ここでは tmpdir を使わず existsSync を直接見る。
 */
describe("ADR-012 Phase 6 / #954: scaffold 副作用の隔離 sanity", () => {
  let beforeCount = 0;
  beforeEach(() => {
    beforeCount = createdPaths.length;
  });
  it("test 間で createdPaths は afterEach により 0 にリセットされるべき", () => {
    expect(beforeCount).toBe(0);
    // tmpdir に dummy ディレクトリを作って (= test infra の sanity)
    const dummy = mkdtempSync(join(tmpdir(), "tc-iact-"));
    rmSync(dummy, { recursive: true });
    expect(existsSync(dummy)).toBe(false);
  });
});
