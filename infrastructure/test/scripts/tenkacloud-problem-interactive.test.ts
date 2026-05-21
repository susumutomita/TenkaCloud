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
  it("should generate the flag scaffold from kind number + ID + Enter (no category override)", async () => {
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

  it("should also accept the kind name (string, not number)", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-uflat`;
    const { prompts } = buildPrompts(["uptime-flat", uniqueId, "", "y"]);
    createdPaths.push(join(REPO_ROOT, "problems/battles", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.kind).toBe("uptime-flat");
    expect(created.category).toBe("Battle");
  });

  it("should accept a category override (switching Challenge to Battle)", async () => {
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

  it("should re-prompt on invalid kind input and proceed when given correct input", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-retry`;
    const { prompts, script } = buildPrompts(["bogus", "9", "1", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.kind).toBe("flag");
    // print 出力に拒否メッセージが残るべき (= UX 確認)
    const allOutput = script.output.join("\n");
    expect(allOutput).toContain("無効");
  });

  it("should reject invalid problemId (uppercase / too short) and re-prompt", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-bad`;
    const { prompts } = buildPrompts(["1", "Bad-ID", "ab", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.outputDir).toContain(uniqueId);
  });

  it("should reject existing problemId and re-prompt (hello-world already in repo)", async () => {
    const uniqueId = `test-iact-${Date.now().toString(36)}-dup`;
    const { prompts, script } = buildPrompts(["1", "hello-world", uniqueId, "", "Y"]);
    createdPaths.push(join(REPO_ROOT, "problems/challenges", uniqueId));

    const { created } = await runInteractive(prompts);
    expect(created.outputDir).toContain(uniqueId);
    expect(script.output.join("\n")).toContain("既に存在");
  });

  it("should throw without generating when confirm is 'n' (abort)", async () => {
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
  it("createdPaths should reset to 0 between tests via afterEach", () => {
    expect(beforeCount).toBe(0);
    // tmpdir に dummy ディレクトリを作って (= test infra の sanity)
    const dummy = mkdtempSync(join(tmpdir(), "tc-iact-"));
    rmSync(dummy, { recursive: true });
    expect(existsSync(dummy)).toBe(false);
  });
});
