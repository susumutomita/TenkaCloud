import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAKE_BINARY = "/usr/bin/make";
const REMOVED_TARGETS = ["help-en", "help-ja", "format", "dup-report", "ever-better-diagnose"];
const HIDDEN_LOCAL_TARGETS = [
  "doctor",
  "local-onboard",
  "local-up",
  "local-portal",
  "local-status",
  "local-list",
  "local-evaluate",
  "local-reset",
  "local-snapshot-export",
  "local-snapshot-import",
  "local-disrupt",
  "local-smoke",
];

interface HelpEntry {
  readonly target: string;
  readonly description: string;
}

function runMakeHelp(args: readonly string[] = []): string {
  return execFileSync(MAKE_BINARY, args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function parseHelpEntries(output: string): HelpEntry[] {
  const entries: HelpEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("  ")) {
      continue;
    }
    const content = line.slice(2);
    const separator = content.indexOf(" ");
    if (separator <= 0) {
      continue;
    }
    const description = content.slice(separator).trim();
    if (description.length > 0) {
      entries.push({ target: content.slice(0, separator), description });
    }
  }
  return entries;
}

function containsHashNumber(value: string): boolean {
  for (let index = 0; index + 1 < value.length; index += 1) {
    if (value[index] !== "#") {
      continue;
    }
    const next = value.charCodeAt(index + 1);
    if (next >= 48 && next <= 57) {
      return true;
    }
  }
  return false;
}

describe("root Makefile help", () => {
  it("should use one root makefile", () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

    expect(existsSync(join(REPO_ROOT, "GNUmakefile"))).toBe(false);
    const lines = makefile.split("\n");
    for (const target of REMOVED_TARGETS) {
      expect(lines.some((line) => line.startsWith(`${target}:`))).toBe(false);
    }
  });

  it("should default to English and switch language through HELP_LANG", () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    const english = runMakeHelp();
    const explicitEnglish = runMakeHelp(["help", "HELP_LANG=en"]);
    const japanese = runMakeHelp(["help", "HELP_LANG=ja"]);
    const englishEntries = parseHelpEntries(english);
    const japaneseEntries = parseHelpEntries(japanese);
    const englishDescriptions = new Map(
      englishEntries.map(({ target, description }) => [target, description]),
    );
    const japaneseDescriptions = new Map(
      japaneseEntries.map(({ target, description }) => [target, description]),
    );

    expect(makefile).toContain("# ===== Problem catalog validation | 問題カタログ検証 =====");
    expect(makefile).toContain(
      "# ===== Problem Packs (author-side CLI) | 問題パック（作成者向けCLI） =====",
    );
    expect(english).toBe(explicitEnglish);
    expect(english).toContain("Language: English (Japanese: make help HELP_LANG=ja)");
    expect(english).toContain("Setup / Build");
    expect(englishDescriptions.get("install")).toBe("Install development dependencies safely");
    expect(englishDescriptions.get("turso-live")).toBe(
      "Start the interactive Turso/AWS live verification wizard",
    );
    expect(englishDescriptions.get("local")).toBe(
      "Start the local drill API and portal via Docker (participant path)",
    );
    expect(englishDescriptions.get("local-down")).toBe(
      "Stop local play and clear all persisted progress",
    );
    expect(englishDescriptions.get("local-dev")).toBe(
      "Start local play on the host with Bun/Vite (developer path, hot reload)",
    );
    for (const hiddenLocalTarget of HIDDEN_LOCAL_TARGETS) {
      expect(englishDescriptions.has(hiddenLocalTarget)).toBe(false);
    }
    expect(english).not.toContain("開発依存関係を安全設定でインストール");
    expect(japanese).toContain("言語: 日本語（英語: make help HELP_LANG=en）");
    expect(japanese).toContain("セットアップ / ビルド");
    expect(japaneseDescriptions.get("install")).toBe("開発依存関係を安全設定でインストール");
    expect(japaneseDescriptions.get("turso-live")).toBe("Turso/AWSの初回live検証wizardを開始");
    expect(japaneseDescriptions.get("local")).toBe("Docker でローカル問題演習を起動(参加者向け)");
    expect(japaneseDescriptions.get("local-dev")).toBe(
      "ホストで Bun/Vite により起動(開発者向け・ホットリロード)",
    );
    expect(japanese).not.toContain("Install development dependencies safely");
    for (const [help, entries] of [
      [english, englishEntries],
      [japanese, japaneseEntries],
    ] as const) {
      expect(containsHashNumber(help)).toBe(false);
      for (const target of ["check-synth"]) {
        expect(entries.filter((entry) => entry.target === target)).toHaveLength(1);
      }
      expect(entries.some((entry) => entry.target === "ensure-deps")).toBe(false);
      expect(entries).toHaveLength(help.split("\n").filter((line) => line.startsWith("  ")).length);
    }
  });
});
