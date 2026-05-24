import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Issue #1227: circular-dependency detector.
 *
 * Detects ES module import cycles in production code via Tarjan's SCC algorithm.
 * Deliberately implemented in-tree (no dependency on `madge` or any external tool)
 * so the analyzer stays self-contained — see PR feedback on #1286.
 *
 * Scope (production code only):
 *   - infrastructure/lib/, infrastructure/bin/
 *   - apps/<spa>/src/
 *   - scripts/
 *   - .claude/harness/src/
 *   - packages/<pkg>/src/
 *
 * Excluded: node_modules, dist, cdk.out, .next, build, *.test.ts(x), test/, __mocks__.
 *
 * Algorithm:
 *   1. Discover TS source files under the production prefixes
 *   2. Parse top-level `import ... from "..."` and `export ... from "..."` (regex,
 *      not a full TS parser — keep zero deps).
 *   3. Resolve specifiers:
 *      - Relative (`./foo`, `../bar`) → resolve to absolute repo-relative path
 *        with `.ts` / `.tsx` / `/index.ts` / `/index.tsx` extension fallback.
 *      - Workspace package (`@TenkaCloud/foo`, `@tenkacloud/foo`) → resolve via
 *        the workspaces map by reading package.json `main` / `exports["."]`.
 *      - Bare specifiers (`hono`, `aws-sdk`) → external, ignored.
 *   4. Build a directed graph `file -> imported file` over the inspected set.
 *   5. Run Tarjan's SCC. Any SCC with size >= 2 is a cycle.
 *
 * Self-loops (file imports itself) are intentionally NOT reported: TypeScript
 * disallows them at the language level, and a 1-node SCC has no self-edge unless
 * the file literally `import "./current"`s itself (= already a syntax error in
 * practice). The rule reports SCCs of size >= 2 only.
 *
 * Severity:
 *   - warning by default
 *   - error when SCC size >= 4 (= the cycle has spread far; refactor cost grows
 *     fast with cycle size).
 *
 * match: `"cycle:" + sorted-filenames-joined-with-|`. Stable across runs so the
 * baseline survives unrelated file edits.
 *
 * filePath: lexicographically smallest member of the SCC (= stable anchor for
 * baselining when the cycle composition itself doesn't change).
 */

const INCLUDE_PATH_PREFIXES = [
  "infrastructure/lib/",
  "infrastructure/bin/",
  "apps/admin-console/src/",
  "apps/application-admin-console/src/",
  "apps/participant-portal/src/",
  "scripts/",
  ".claude/harness/src/",
  "packages/portal-plugin-sdk/src/",
  "packages/trust-bridge/src/",
] as const;

const EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\/node_modules\//,
  /\/dist\//,
  /\/cdk\.out\//,
  /\/\.next\//,
  /\/build\//,
  /\/test\//,
  /\/__generated__\//,
  /\/__mocks__\//,
];

const ERROR_SCC_SIZE = 4;

function shouldInspect(path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  return INCLUDE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// `import ... from "x"` / `import "x"` (side-effect) / `export ... from "x"` /
// `export * from "x"`. Captures the specifier in group 1. We restrict to lines
// starting (optionally indented) so we ignore the word "import" inside code.
const IMPORT_RE =
  /^\s*(?:import\s+(?:type\s+)?(?:[^"']*?\bfrom\s+)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+)["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/gm;

/**
 * Extract every module specifier referenced by `import` / `export ... from` /
 * side-effect `import "..."` statements at the top of `source`. Dynamic
 * `import(...)` is intentionally excluded.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  // Strip block comments first so we don't catch `import` inside `/* ... */`.
  const cleaned = stripBlockComments(source);
  for (const m of cleaned.matchAll(IMPORT_RE)) {
    const s = m[1];
    if (s) specs.add(s);
  }
  for (const m of cleaned.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    const s = m[1];
    if (s) specs.add(s);
  }
  return [...specs];
}

interface StripState {
  readonly out: string;
  readonly i: number;
  readonly inBlock: boolean;
}

function stripInsideBlock(source: string, i: number): StripState {
  const c = source[i] ?? "";
  const n = source[i + 1] ?? "";
  if (c === "*" && n === "/") return { out: "", i: i + 2, inBlock: false };
  // preserve newlines so line-based regexes still align if needed later
  return { out: c === "\n" ? "\n" : " ", i: i + 1, inBlock: true };
}

function stripOutsideBlock(source: string, i: number): StripState {
  const c = source[i] ?? "";
  const n = source[i + 1] ?? "";
  if (c === "/" && n === "*") return { out: "", i: i + 2, inBlock: true };
  if (c === "/" && n === "/") {
    // line comment: skip to next newline
    let j = i;
    while (j < source.length && source[j] !== "\n") j += 1;
    return { out: "", i: j, inBlock: false };
  }
  return { out: c, i: i + 1, inBlock: false };
}

function stripBlockComments(source: string): string {
  const parts: string[] = [];
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    const next = inBlock ? stripInsideBlock(source, i) : stripOutsideBlock(source, i);
    parts.push(next.out);
    i = next.i;
    inBlock = next.inBlock;
  }
  return parts.join("");
}

/**
 * Workspace package map = { "@tenkacloud/foo": "packages/foo/src/index.ts" }.
 * Built once per `check()` run from the listed package.json files.
 */
export interface WorkspaceMap {
  readonly byName: ReadonlyMap<string, string>;
}

const PACKAGE_JSON_PATHS = [
  "packages/portal-plugin-sdk/package.json",
  "packages/trust-bridge/package.json",
] as const;

export function buildWorkspaceMap(ctx: RuleContext): WorkspaceMap {
  const byName = new Map<string, string>();
  for (const pkgPath of PACKAGE_JSON_PATHS) {
    let raw: string;
    try {
      raw = ctx.readFile(pkgPath);
    } catch {
      continue;
    }
    let json: { name?: string; main?: string; exports?: unknown };
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const name = json.name;
    if (!name) continue;
    const entry = pickPackageEntry(json);
    if (!entry) continue;
    const dir = pkgPath.replace(/\/package\.json$/, "");
    const resolved = normalize(`${dir}/${entry}`);
    byName.set(name, resolved);
    // Common variation: `@TenkaCloud/foo` capitalisation in source while
    // package.json declares `@tenkacloud/foo`. Match case-insensitively by
    // registering both forms.
    byName.set(name.toLowerCase(), resolved);
  }
  return { byName };
}

function pickPackageEntry(json: { main?: string; exports?: unknown }): string | undefined {
  const exp = json.exports;
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const t = dot as Record<string, unknown>;
      const candidate = t.import ?? t.default ?? t.types;
      if (typeof candidate === "string") return candidate;
    }
  }
  return json.main;
}

/** Resolve `./foo` / `../bar/baz` against the importer file's directory. */
function resolveRelative(
  importer: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  const importerDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  const joined = normalize(`${importerDir}/${specifier}`);
  return resolveExtensions(joined, fileSet);
}

function resolveExtensions(base: string, fileSet: ReadonlySet<string>): string | undefined {
  // Order matters: explicit extension already on the path > .ts > .tsx > /index.ts > /index.tsx
  const candidates =
    base.endsWith(".ts") || base.endsWith(".tsx")
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

function resolveWorkspace(
  specifier: string,
  workspaces: WorkspaceMap,
  fileSet: ReadonlySet<string>,
): string | undefined {
  // Exact match or `@scope/pkg/subpath` form. We only model the package entry
  // point; subpath imports resolve to the entry too (good enough for SCC).
  const direct = workspaces.byName.get(specifier) ?? workspaces.byName.get(specifier.toLowerCase());
  if (direct && fileSet.has(direct)) return direct;
  const slashIdx = specifier.indexOf(
    "/",
    specifier.startsWith("@") ? specifier.indexOf("/") + 1 : 0,
  );
  if (slashIdx > 0) {
    const root = specifier.slice(0, slashIdx);
    const entry = workspaces.byName.get(root) ?? workspaces.byName.get(root.toLowerCase());
    if (entry && fileSet.has(entry)) return entry;
  }
  return undefined;
}

/**
 * Resolve a single import specifier from `importer` to a repo-relative TS file.
 * Returns undefined for external bare specifiers (= no edge in the graph).
 */
export function resolveSpecifier(
  importer: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  workspaces: WorkspaceMap,
): string | undefined {
  if (specifier.startsWith(".")) return resolveRelative(importer, specifier, fileSet);
  if (specifier.startsWith("@") || /^[a-z]/.test(specifier)) {
    return resolveWorkspace(specifier, workspaces, fileSet);
  }
  return undefined;
}

function normalize(path: string): string {
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      // preserve leading "" only if path started with "/" — repo-relative paths don't
      continue;
    }
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

export interface BuildGraphResult {
  readonly nodes: readonly string[];
  /** adjacency list: nodes[i] -> indices into nodes */
  readonly edges: readonly (readonly number[])[];
}

function safeRead(ctx: RuleContext, path: string): string | undefined {
  try {
    return ctx.readFile(path);
  } catch {
    return undefined;
  }
}

function collectEdgesFor(
  importer: string,
  content: string,
  fileSet: ReadonlySet<string>,
  workspaces: WorkspaceMap,
  idx: ReadonlyMap<string, number>,
): number[] {
  const specs = extractImportSpecifiers(content);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const spec of specs) {
    const target = resolveSpecifier(importer, spec, fileSet, workspaces);
    if (!target || target === importer) continue;
    const j = idx.get(target);
    if (j === undefined || seen.has(j)) continue;
    seen.add(j);
    out.push(j);
  }
  return out;
}

export function buildGraph(ctx: RuleContext): BuildGraphResult {
  const files = ctx.files.filter(shouldInspect).sort();
  const fileSet = new Set(files);
  const workspaces = buildWorkspaceMap(ctx);
  const idx = new Map<string, number>();
  for (let k = 0; k < files.length; k += 1) {
    const f = files[k];
    if (f) idx.set(f, k);
  }
  const edges: number[][] = files.map(() => []);
  for (let i = 0; i < files.length; i += 1) {
    const importer = files[i];
    if (!importer) continue;
    const content = safeRead(ctx, importer);
    if (content === undefined) continue;
    edges[i] = collectEdgesFor(importer, content, fileSet, workspaces, idx);
  }
  return { nodes: files, edges };
}

/**
 * Tarjan's strongly-connected-components algorithm. Returns components of size
 * >= 2 (= cycles). Uses an explicit work stack to avoid blowing the JS call
 * stack on large graphs.
 *
 * The function is split into 3 helpers to keep cognitive complexity low:
 *   - `tarjanVisit`   — discover a fresh node (assign index/lowlink, push stacks)
 *   - `tarjanAdvance` — process the next edge of the work-stack top frame
 *   - `tarjanPopSCC`  — drain stack into an SCC when a root is finished
 */
interface TarjanState {
  readonly graph: BuildGraphResult;
  readonly index: Int32Array;
  readonly lowlink: Int32Array;
  readonly onStack: Uint8Array;
  readonly stack: number[];
  readonly work: { v: number; i: number }[];
  readonly sccs: number[][];
  nextIndex: number;
}

function tarjanVisit(s: TarjanState, v: number): void {
  s.index[v] = s.nextIndex;
  s.lowlink[v] = s.nextIndex;
  s.nextIndex += 1;
  s.stack.push(v);
  s.onStack[v] = 1;
  s.work.push({ v, i: 0 });
}

function tarjanAdvance(s: TarjanState, top: { v: number; i: number }): boolean {
  const adj = s.graph.edges[top.v] ?? [];
  if (top.i >= adj.length) return false;
  const w = adj[top.i];
  top.i += 1;
  if (w === undefined) return true;
  if (s.index[w] === -1) {
    tarjanVisit(s, w);
  } else if (s.onStack[w] === 1) {
    s.lowlink[top.v] = Math.min(s.lowlink[top.v] ?? 0, s.index[w] ?? 0);
  }
  return true;
}

function tarjanPopSCC(s: TarjanState, v: number): void {
  if (s.lowlink[v] !== s.index[v]) return;
  const component: number[] = [];
  while (true) {
    const w = s.stack.pop();
    if (w === undefined) break;
    s.onStack[w] = 0;
    component.push(w);
    if (w === v) break;
  }
  if (component.length >= 2) s.sccs.push(component);
}

function tarjanStep(s: TarjanState): void {
  const top = s.work[s.work.length - 1];
  if (!top) return;
  if (tarjanAdvance(s, top)) return;
  // Post-order: finished node — emit SCC if root, then propagate lowlink upward.
  tarjanPopSCC(s, top.v);
  s.work.pop();
  const parent = s.work[s.work.length - 1];
  if (parent) {
    s.lowlink[parent.v] = Math.min(s.lowlink[parent.v] ?? 0, s.lowlink[top.v] ?? 0);
  }
}

export function findCycles(graph: BuildGraphResult): readonly (readonly number[])[] {
  const n = graph.nodes.length;
  const s: TarjanState = {
    graph,
    index: new Int32Array(n).fill(-1),
    lowlink: new Int32Array(n),
    onStack: new Uint8Array(n),
    stack: [],
    work: [],
    sccs: [],
    nextIndex: 0,
  };
  for (let root = 0; root < n; root += 1) {
    if (s.index[root] !== -1) continue;
    tarjanVisit(s, root);
    while (s.work.length > 0) tarjanStep(s);
  }
  return s.sccs;
}

function sccToFinding(scc: readonly number[], nodes: readonly string[]): Finding {
  const files = scc
    .map((i) => nodes[i] ?? "")
    .filter((f) => f.length > 0)
    .sort();
  const filePath = files[0] ?? "(unknown)";
  const severity = files.length >= ERROR_SCC_SIZE ? "error" : "warning";
  const match = `cycle:${files.join("|")}`;
  return {
    ruleId: "circular-dependency",
    severity,
    filePath,
    line: 1,
    match,
    message: `Circular dependency among ${files.length} files: ${files.join(", ")}`,
    recommendation:
      "Break the cycle by extracting shared types/utilities to a leaf module, " +
      "or invert the dependency direction (e.g. via a callback / interface defined in the consumer).",
  };
}

export const circularDependency: Rule = {
  id: "circular-dependency",
  severity: "warning",
  check(ctx: RuleContext): readonly Finding[] {
    const graph = buildGraph(ctx);
    const sccs = findCycles(graph);
    const findings = sccs.map((scc) => sccToFinding(scc, graph.nodes));
    // Stable order = baseline-friendly diffs.
    findings.sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
      return (a.match ?? "").localeCompare(b.match ?? "");
    });
    return findings;
  },
};

export const __INTERNAL = { ERROR_SCC_SIZE, INCLUDE_PATH_PREFIXES, EXCLUDE_PATTERNS };
