import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const NOTICE_HEADER =
  "THIRD_PARTY_NOTICES.txt\n" +
  "\n" +
  "This file is generated from the installed production dependency tree.\n" +
  "Regenerate it with: bun run scripts/generate-oss-notices.ts\n";

const MISSING_LICENSE_NOTE = "NOTE: package did not ship a LICENSE / LICENCE / COPYING file.";

const COPYLEFT_LICENSE_PATTERN = /\b(AGPL|GPL|LGPL|MPL|EPL|CDDL|CPL|OSL|SSPL|EUPL|CeCILL)\b/i;

// permissive な SPDX トークン。 dual license (`A OR B`) の electable 判定に使う。
const PERMISSIVE_LICENSE_PATTERN =
  /\b(MIT|Apache|BSD|ISC|0BSD|Unlicense|Zlib|BlueOak|CC0|Python|WTFPL)\b/i;

/**
 * 「copyleft の義務が実際に生じる」ライセンスかを判定する。 SPDX の dual license (`A OR B`) は
 * licensee が選べるので、 permissive な選択肢があれば概念上 copyleft ではない (例:
 * `(MIT OR GPL-3.0-or-later)` は MIT を、 `(MPL-2.0 OR Apache-2.0)` は Apache-2.0 を選択できる)。
 * よって `OR` に permissive を含む式は flag せず、 単独 copyleft や `AND` 結合のみ flag する。
 */
export function isCopyleftLicense(license: string): boolean {
  if (!COPYLEFT_LICENSE_PATTERN.test(license)) return false;
  const electablePermissive = /\bOR\b/i.test(license) && PERMISSIVE_LICENSE_PATTERN.test(license);
  return !electablePermissive;
}

type DependencyMap = Record<string, string>;

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly dependencies?: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

export interface NoticeWorkspace {
  readonly name: string;
  readonly dir: string;
  readonly dependencies: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
}

export interface NoticeEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly packageDir: string;
  readonly licenseFile: string | undefined;
  readonly licenseText: string | undefined;
  readonly copyleft: boolean;
}

export interface NoticeCollection {
  readonly entries: readonly NoticeEntry[];
  readonly copyleftEntries: readonly NoticeEntry[];
  readonly warnings: readonly string[];
}

export interface NoticeCollectOptions {
  readonly repoRoot: string;
  readonly workspaces: readonly NoticeWorkspace[];
  readonly workspacePackageNames: ReadonlySet<string>;
}

export interface GenerateNoticesOptions {
  readonly repoRoot?: string;
  readonly outputPath?: string;
  readonly check?: boolean;
}

export interface GenerateNoticesResult {
  readonly collection: NoticeCollection;
  readonly outputPath: string;
  readonly text: string;
  readonly changed: boolean;
}

interface DependencyQueueItem {
  readonly name: string;
  readonly fromDir: string;
  readonly optional: boolean;
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readPackageJson(pkgDir: string): PackageJson | undefined {
  const path = join(pkgDir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return readJsonFile<PackageJson>(path);
  } catch {
    return undefined;
  }
}

function dependencyEntries(
  pkg: Pick<PackageJson, "dependencies" | "optionalDependencies">,
): readonly { readonly name: string; readonly optional: boolean }[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
  ];
}

function normalizeWorkspacePatterns(workspaces: PackageJson["workspaces"]): readonly string[] {
  if (Array.isArray(workspaces)) return workspaces;
  if (Array.isArray(workspaces?.packages)) return workspaces.packages;
  return [];
}

function expandWorkspacePattern(repoRoot: string, pattern: string): readonly string[] {
  if (!pattern.endsWith("/*")) return [join(repoRoot, pattern)];
  const base = join(repoRoot, pattern.slice(0, -2));
  if (!safeIsDirectory(base)) return [];
  return readdirSync(base)
    .map((entry) => join(base, entry))
    .filter((path) => safeIsDirectory(path));
}

export function discoverNoticeWorkspaces(repoRoot = REPO_ROOT): {
  readonly workspaces: readonly NoticeWorkspace[];
  readonly workspacePackageNames: ReadonlySet<string>;
} {
  const rootPackage = readJsonFile<PackageJson>(join(repoRoot, "package.json"));
  const workspaces: NoticeWorkspace[] = [];
  const workspacePackageNames = new Set<string>();
  if (rootPackage.name) workspacePackageNames.add(rootPackage.name);
  if (
    Object.keys(rootPackage.dependencies ?? {}).length > 0 ||
    Object.keys(rootPackage.optionalDependencies ?? {}).length > 0
  ) {
    workspaces.push({
      name: rootPackage.name ?? "<root>",
      dir: repoRoot,
      dependencies: rootPackage.dependencies ?? {},
      optionalDependencies: rootPackage.optionalDependencies,
    });
  }

  for (const pattern of normalizeWorkspacePatterns(rootPackage.workspaces)) {
    for (const dir of expandWorkspacePattern(repoRoot, pattern)) {
      const pkg = readPackageJson(dir);
      if (!pkg?.name) continue;
      workspacePackageNames.add(pkg.name);
      workspaces.push({
        name: pkg.name,
        dir,
        dependencies: pkg.dependencies ?? {},
        optionalDependencies: pkg.optionalDependencies,
      });
    }
  }

  return { workspaces, workspacePackageNames };
}

function packageNameToPath(name: string): readonly string[] {
  return name.startsWith("@") ? name.split("/") : [name];
}

function resolvePackageDir(
  packageName: string,
  fromDir: string,
  repoRoot: string,
): string | undefined {
  const parts = packageNameToPath(packageName);
  let current = resolve(fromDir);
  const root = resolve(repoRoot);
  while (current.startsWith(root)) {
    const candidate = join(current, "node_modules", ...parts);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  const rootCandidate = join(root, "node_modules", ...parts);
  if (existsSync(join(rootCandidate, "package.json"))) return rootCandidate;
  return undefined;
}

function licenseToString(pkg: PackageJson): string {
  if (typeof pkg.license === "string" && pkg.license.trim().length > 0) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object") {
    const maybeType = (pkg.license as { readonly type?: unknown }).type;
    if (typeof maybeType === "string" && maybeType.trim().length > 0) return maybeType.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const licenses = pkg.licenses
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const maybeType = (entry as { readonly type?: unknown }).type;
          return typeof maybeType === "string" ? maybeType : undefined;
        }
        return undefined;
      })
      .filter((entry): entry is string => entry !== undefined && entry.trim().length > 0);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return "UNKNOWN";
}

function findLicenseFile(pkgDir: string): string | undefined {
  const candidates = readdirSync(pkgDir)
    .filter((entry) => {
      const lower = entry.toLowerCase();
      return (
        lower === "license" ||
        lower.startsWith("license.") ||
        lower === "licence" ||
        lower.startsWith("licence.") ||
        lower === "copying" ||
        lower.startsWith("copying.")
      );
    })
    .sort((a, b) => licenseFileRank(a) - licenseFileRank(b) || a.localeCompare(b));
  for (const candidate of candidates) {
    const path = join(pkgDir, candidate);
    if (!safeIsDirectory(path)) return path;
  }
  return undefined;
}

function licenseFileRank(fileName: string): number {
  const lower = fileName.toLowerCase();
  if (lower === "license") return 0;
  if (lower.startsWith("license.")) return 1;
  if (lower === "licence") return 2;
  if (lower.startsWith("licence.")) return 3;
  if (lower === "copying") return 4;
  return 5;
}

function toNoticeEntry(packageDir: string, pkg: PackageJson, fallbackName: string): NoticeEntry {
  const license = licenseToString(pkg);
  const licenseFile = findLicenseFile(packageDir);
  return {
    name: pkg.name ?? fallbackName,
    version: pkg.version ?? "0.0.0",
    license,
    packageDir,
    licenseFile,
    licenseText: licenseFile ? normalizeLicenseText(readFileSync(licenseFile, "utf8")) : undefined,
    copyleft: isCopyleftLicense(license),
  };
}

function normalizeLicenseText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function collectThirdPartyNotices(opts: NoticeCollectOptions): NoticeCollection {
  const entriesByPackageDir = new Map<string, NoticeEntry>();
  const warnings: string[] = [];
  const queue = seedDependencyQueue(opts.workspaces);
  const visited = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const dep = queue[index];
    if (!dep) continue;
    const packageDir = resolveQueuedPackage(dep, opts.repoRoot, warnings);
    if (!packageDir) continue;
    const visitKey = `${dep.name}\0${packageDir}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const pkg = readPackageJson(packageDir);
    if (!pkg) {
      warnings.push(`Failed to read package.json for ${dep.name} at ${packageDir}`);
      continue;
    }

    if (!opts.workspacePackageNames.has(pkg.name ?? dep.name)) {
      entriesByPackageDir.set(packageDir, toNoticeEntry(packageDir, pkg, dep.name));
    }

    enqueuePackageDependencies(queue, pkg, packageDir);
  }

  const entries = [...entriesByPackageDir.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return {
    entries,
    copyleftEntries: entries.filter((entry) => entry.copyleft),
    warnings,
  };
}

function seedDependencyQueue(workspaces: readonly NoticeWorkspace[]): DependencyQueueItem[] {
  const queue: DependencyQueueItem[] = [];
  for (const workspace of workspaces) enqueuePackageDependencies(queue, workspace, workspace.dir);
  return queue;
}

function enqueuePackageDependencies(
  queue: DependencyQueueItem[],
  pkg: Pick<PackageJson, "dependencies" | "optionalDependencies">,
  fromDir: string,
): void {
  for (const dep of dependencyEntries(pkg)) queue.push({ ...dep, fromDir });
}

function resolveQueuedPackage(
  dep: DependencyQueueItem,
  repoRoot: string,
  warnings: string[],
): string | undefined {
  const packageDir = resolvePackageDir(dep.name, dep.fromDir, repoRoot);
  if (packageDir) return packageDir;
  if (!dep.optional) {
    warnings.push(`Missing installed package for dependency ${dep.name} from ${dep.fromDir}`);
  }
  return undefined;
}

function renderEntry(entry: NoticeEntry): string {
  const lines = [
    "--------------------------------------------------------------------------------",
    `${entry.name}@${entry.version} - ${entry.license}`,
  ];
  if (entry.copyleft) {
    lines.push("WARNING: copyleft/non-permissive license detected. Review before shipping.");
  }
  lines.push("");
  lines.push(entry.licenseText ?? MISSING_LICENSE_NOTE);
  return lines.join("\n");
}

export function buildThirdPartyNotices(collection: NoticeCollection): string {
  const warnings = collection.warnings.length
    ? `\nWarnings:\n${collection.warnings.map((warning) => `- ${warning}`).join("\n")}\n`
    : "";
  const entries = collection.entries.map(renderEntry).join("\n\n");
  return `${NOTICE_HEADER}${warnings}\n${entries}\n`;
}

export function generateThirdPartyNotices(
  opts: GenerateNoticesOptions = {},
): GenerateNoticesResult {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const outputPath = opts.outputPath ?? join(repoRoot, "THIRD_PARTY_NOTICES.txt");
  const workspaceInfo = discoverNoticeWorkspaces(repoRoot);
  const collection = collectThirdPartyNotices({
    repoRoot,
    workspaces: workspaceInfo.workspaces,
    workspacePackageNames: workspaceInfo.workspacePackageNames,
  });
  const text = buildThirdPartyNotices(collection);
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : undefined;
  const changed = current !== text;
  if (!opts.check && changed) writeFileSync(outputPath, text, "utf8");
  return { collection, outputPath, text, changed };
}
