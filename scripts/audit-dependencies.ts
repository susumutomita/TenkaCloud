#!/usr/bin/env bun
/**
 * Supply Chain Security 防御: dependency lifecycle script auditor (snapshot-based)。
 *
 * 背景: mini Shai-Hulud 第二波 (2026-05、 https://blog.flatt.tech/entry/mini_shai_hulud_2nd)
 * では悪意ある transitive dep の `prepare` / `postinstall` で credential exfil / C2 接続が
 * 行われた。 Bun は default で transitive lifecycle script を block する (= trustedDependencies
 * model) ため secure-by-default だが、 次のケースをこの audit で検出する:
 *
 *   1. 新しい (= baseline に無い) 依存が lifecycle script 付きで install された
 *      → 既知 dep の侵害可能性 / 意図しない新 dep の追加を検出
 *   2. 既存依存が新しい lifecycle script を獲得した
 *      → 依存 update に紛れて attack vector が増えていないか検出
 *
 * 仕組み: 全 `node_modules/<pkg>/package.json` を scan し lifecycle script を持つ entry を
 * 列挙 → `scripts/audit-baseline.json` (= 直近の承認済 snapshot) と diff → 差分があれば fail。
 *
 * baseline の更新は人間 review 前提 (= `bun run scripts/audit-dependencies.ts --update`)。
 *
 * lifecycle script の定義: install 時に **実際に発火する** script のみ:
 *   - preinstall / install / postinstall (= pure install-time hook)
 *   - preprepare / prepare / postprepare (= install 後にも実行、 攻撃に多用)
 *   - prepublish / prepublishOnly は除外 (= publish 時のみ、 consumer install では発火せず)
 *
 * False positive を避けるため workspace package (= packages/* / apps/* / infrastructure) は skip。
 *
 * 出力: baseline と差分なし → "OK"。 差分あり → 一覧 + exit 1。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(__dirname, "audit-baseline.json");

const LIFECYCLE_SCRIPT_KEYS = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
] as const;
type LifecycleKey = (typeof LIFECYCLE_SCRIPT_KEYS)[number];

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: Record<string, string>;
  readonly trustedDependencies?: readonly string[];
}

interface Finding {
  readonly packageName: string;
  /** lifecycle script の key 集合 (= 値は除く、 baseline は key 集合の存在のみ pin する)。 */
  readonly scriptKeys: readonly LifecycleKey[];
}

interface BaselineSnapshot {
  readonly version: 1;
  readonly description: string;
  readonly entries: Readonly<Record<string, readonly LifecycleKey[]>>;
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function scanNodeModules(rootNodeModules: string): readonly Finding[] {
  if (!existsSync(rootNodeModules)) return [];
  const findings: Finding[] = [];
  for (const entry of readdirSync(rootNodeModules)) {
    if (entry.startsWith(".")) continue;
    const entryPath = join(rootNodeModules, entry);
    if (!safeIsDirectory(entryPath)) continue;
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(entryPath)) {
        if (scoped.startsWith(".")) continue;
        const pkgPath = join(entryPath, scoped);
        if (!safeIsDirectory(pkgPath)) continue;
        const f = inspectPackage(pkgPath, `${entry}/${scoped}`);
        if (f) findings.push(f);
      }
    } else {
      const f = inspectPackage(entryPath, entry);
      if (f) findings.push(f);
    }
  }
  return findings;
}

function inspectPackage(pkgDir: string, expectedName: string): Finding | undefined {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return undefined;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  const scripts = pkg.scripts;
  if (!scripts) return undefined;
  const scriptKeys: LifecycleKey[] = [];
  for (const key of LIFECYCLE_SCRIPT_KEYS) {
    const v = scripts[key];
    if (typeof v === "string" && v.length > 0) {
      scriptKeys.push(key);
    }
  }
  if (scriptKeys.length === 0) return undefined;
  return { packageName: pkg.name ?? expectedName, scriptKeys };
}

function readRootPackage(): PackageJson {
  const p = join(REPO_ROOT, "package.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

function listWorkspacePackages(): readonly string[] {
  const names: string[] = [];
  const root = readRootPackage();
  if (root.name) names.push(root.name);
  for (const dir of ["apps", "packages", "infrastructure"]) {
    const base = join(REPO_ROOT, dir);
    if (!existsSync(base)) continue;
    if (statSync(base).isFile()) continue;
    const entries = dir === "infrastructure" ? ["."] : readdirSync(base);
    for (const entry of entries) {
      const wsPath = dir === "infrastructure" ? base : join(base, entry);
      const pkgJson = join(wsPath, "package.json");
      if (!existsSync(pkgJson)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as PackageJson;
        if (pkg.name) names.push(pkg.name);
      } catch {
        // ignore
      }
    }
  }
  return names;
}

function loadBaseline(): BaselineSnapshot | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineSnapshot;
  } catch {
    return undefined;
  }
}

function saveBaseline(findings: readonly Finding[]): void {
  const entries: Record<string, readonly LifecycleKey[]> = {};
  for (const f of [...findings].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    entries[f.packageName] = [...f.scriptKeys].sort();
  }
  const snapshot: BaselineSnapshot = {
    version: 1,
    description:
      "Approved set of npm packages with install-time lifecycle scripts (preinstall/install/postinstall/preprepare/prepare/postprepare). Bun's trustedDependencies model already blocks execution by default; this baseline pins the attack surface so any NEW package or NEW lifecycle hook in CI requires explicit human review. Update via: bun run scripts/audit-dependencies.ts --update",
    entries,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

interface DiffResult {
  readonly added: readonly { name: string; scriptKeys: readonly LifecycleKey[] }[];
  readonly newHooks: readonly { name: string; added: readonly LifecycleKey[] }[];
  readonly removed: readonly string[];
}

function diffAgainstBaseline(findings: readonly Finding[], baseline: BaselineSnapshot): DiffResult {
  const currentByName = new Map<string, readonly LifecycleKey[]>();
  for (const f of findings) currentByName.set(f.packageName, f.scriptKeys);

  const added: { name: string; scriptKeys: readonly LifecycleKey[] }[] = [];
  const newHooks: { name: string; added: readonly LifecycleKey[] }[] = [];
  for (const [name, keys] of currentByName.entries()) {
    const prior = baseline.entries[name];
    if (!prior) {
      added.push({ name, scriptKeys: [...keys].sort() });
    } else {
      const priorSet = new Set(prior);
      const newlyAdded = keys.filter((k) => !priorSet.has(k));
      if (newlyAdded.length > 0) {
        newHooks.push({ name, added: [...newlyAdded].sort() });
      }
    }
  }
  const removed: string[] = [];
  for (const name of Object.keys(baseline.entries)) {
    if (!currentByName.has(name)) removed.push(name);
  }
  return { added, newHooks, removed };
}

export interface AuditOutcome {
  readonly ok: boolean;
  readonly totalScanned: number;
  readonly skippedWorkspace: readonly string[];
  readonly diff?: DiffResult;
  readonly mode: "baseline-missing" | "diff" | "updated";
}

export function runAudit(opts?: { nodeModulesPath?: string; update?: boolean }): AuditOutcome {
  const rootNodeModules = opts?.nodeModulesPath ?? join(REPO_ROOT, "node_modules");
  const workspaceNames = new Set(listWorkspacePackages());

  const allFindings = scanNodeModules(rootNodeModules);
  const findings = allFindings.filter((f) => !workspaceNames.has(f.packageName));
  const skippedWorkspace = allFindings
    .filter((f) => workspaceNames.has(f.packageName))
    .map((f) => f.packageName);

  if (opts?.update) {
    saveBaseline(findings);
    return {
      ok: true,
      totalScanned: findings.length,
      skippedWorkspace,
      mode: "updated",
    };
  }

  const baseline = loadBaseline();
  if (!baseline) {
    // 初回 / baseline 削除されたケース。 即 OK は許さず、 update を明示的に促す。
    return {
      ok: false,
      totalScanned: findings.length,
      skippedWorkspace,
      mode: "baseline-missing",
    };
  }
  const diff = diffAgainstBaseline(findings, baseline);
  const ok = diff.added.length === 0 && diff.newHooks.length === 0;
  return { ok, totalScanned: findings.length, skippedWorkspace, diff, mode: "diff" };
}

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const outcome = runAudit({ update });

  if (outcome.mode === "updated") {
    console.log(
      `Updated ${BASELINE_PATH} with ${outcome.totalScanned} package(s) (${outcome.skippedWorkspace.length} workspace skipped).`,
    );
    return;
  }
  if (outcome.mode === "baseline-missing") {
    console.error(`NG baseline missing: ${BASELINE_PATH}`);
    console.error(
      `Run \`bun run scripts/audit-dependencies.ts --update\` after reviewing the package set.`,
    );
    process.exit(1);
  }

  if (outcome.ok) {
    console.log(
      `OK ${outcome.totalScanned} package(s) with install-time lifecycle scripts. ` +
        `No new packages or hooks vs baseline.`,
    );
    return;
  }

  const diff = outcome.diff;
  if (!diff) {
    console.error("NG diff missing (internal error)");
    process.exit(1);
  }
  console.error("NG Supply chain audit failed: new lifecycle scripts vs baseline.\n");
  if (diff.added.length > 0) {
    console.error(`${diff.added.length} new package(s) with lifecycle scripts:`);
    for (const a of diff.added) {
      console.error(`  + ${a.name}  [${a.scriptKeys.join(", ")}]`);
    }
    console.error("");
  }
  if (diff.newHooks.length > 0) {
    console.error(`${diff.newHooks.length} package(s) gained new lifecycle hook(s):`);
    for (const h of diff.newHooks) {
      console.error(`  ~ ${h.name}  +[${h.added.join(", ")}]`);
    }
    console.error("");
  }
  console.error(
    `If you recognize all changes and they look safe, run:\n` +
      `  bun run scripts/audit-dependencies.ts --update\n` +
      `and commit the updated scripts/audit-baseline.json.\n\n` +
      `If a package is unfamiliar, this may indicate a supply chain compromise.\n` +
      `Reference: https://blog.flatt.tech/entry/mini_shai_hulud_2nd`,
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
