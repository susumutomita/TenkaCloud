/**
 * Issue #1975: local self-paced mode の問題カタログ loader。
 *
 * `problems/` submodule (challenges/ + battles/) の各 `metadata.json` を読み、 local
 * Participant API が `/portal/me` を組み立てるための最小 view に正規化する。 fs アクセスは
 * 引数で注入して unit test 可能にする (= 純関数 + injected deps)。
 *
 * 採点や hint content は local mode では「公開してよい」 (= 不正防止は非目標、 #1975 非目標節)。
 */

export interface LocalHint {
  readonly id: string;
  readonly penalty: number;
  readonly content: string;
}

export interface LocalEndpoint {
  readonly slot: string;
  readonly label?: string;
  readonly description?: string;
  readonly overridable: boolean;
  readonly defaultKey: string;
}

export interface LocalCatalogProblem {
  readonly problemId: string;
  /** "Battle" | "Challenge" (ADR-005 の 2 軸)。 */
  readonly category: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly scoringKind: string;
  readonly points: number;
  readonly hints: readonly LocalHint[];
  readonly endpoints: readonly LocalEndpoint[];
}

export interface CatalogFs {
  readonly existsSync: (path: string) => boolean;
  readonly readdirSync: (path: string) => readonly string[];
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly statIsDirectory: (path: string) => boolean;
}

/** metadata.json の最小 shape (本 loader が参照する field のみ)。 */
interface RawMetadata {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  instructions?: unknown;
  scoring?: {
    kind?: unknown;
    points?: unknown;
    hints?: unknown;
  };
  endpoints?: unknown;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeHints(raw: unknown): LocalHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: LocalHint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { id?: unknown; penalty?: unknown; content?: unknown };
    const id = str(e.id);
    if (!id) continue;
    hints.push({ id, penalty: num(e.penalty), content: str(e.content) });
  }
  return hints;
}

function normalizeEndpoints(raw: unknown): LocalEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const endpoints: LocalEndpoint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as {
      slot?: unknown;
      label?: unknown;
      description?: unknown;
      overridable?: unknown;
      default?: { key?: unknown };
    };
    const slot = str(e.slot);
    if (!slot) continue;
    const endpoint: LocalEndpoint = {
      slot,
      overridable: e.overridable === true,
      defaultKey: str(e.default?.key),
      ...(typeof e.label === "string" ? { label: e.label } : {}),
      ...(typeof e.description === "string" ? { description: e.description } : {}),
    };
    endpoints.push(endpoint);
  }
  return endpoints;
}

function toProblem(problemId: string, meta: RawMetadata): LocalCatalogProblem {
  const scoring = meta.scoring ?? {};
  return {
    problemId,
    category: str(meta.category, "Challenge"),
    name: str(meta.name, problemId),
    description: str(meta.description),
    instructions: str(meta.instructions),
    scoringKind: str(scoring.kind, "flag"),
    points: num(scoring.points),
    hints: normalizeHints(scoring.hints),
    endpoints: normalizeEndpoints(meta.endpoints),
  };
}

/**
 * local mode で実際に「解ける」 scoring kind。 local の submit-flag は単一 flag
 * (`flag === localPracticeFlag(problemId)`) しか採点しないため、 flag kind だけが本当に解ける。
 * uptime-flat / uptime-multi / phased-polling / attack-detection は live な endpoint health を、
 * multi-flag は複数 flag 採点を要し、 いずれも AWS deploy 無しの local では成立しない。
 */
const LOCAL_SOLVABLE_KIND = "flag";

/** challenges/ + battles/ を走査して全 problem を読み込む (= filter 前の生カタログ)。 */
function readAllProblems(problemsDir: string, fs: CatalogFs): LocalCatalogProblem[] {
  const groups = ["challenges", "battles"];
  const problems: LocalCatalogProblem[] = [];
  for (const group of groups) {
    const groupDir = `${problemsDir}/${group}`;
    if (!fs.existsSync(groupDir) || !fs.statIsDirectory(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const metaPath = `${groupDir}/${entry}/metadata.json`;
      if (!fs.existsSync(metaPath)) continue;
      let meta: RawMetadata;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as RawMetadata;
      } catch {
        // 壊れた metadata は local catalog から黙って除外せず skip (= fail-soft、 他問題は出す)。
        continue;
      }
      const problemId = str(meta.id, entry);
      problems.push(toProblem(problemId, meta));
    }
  }
  problems.sort((a, b) => a.problemId.localeCompare(b.problemId));
  return problems;
}

/**
 * challenges/ + battles/ を走査し、 local で本当に解ける flag kind の problem だけを返す。
 *
 * 非 flag kind を黙って落とすと「カタログに無い」 ように見えてしまうので、 隠した件数と id を
 * `log` (= caller の出力機構) で明示する (= 正直に「N 問は AWS deploy が必要なので非表示」)。
 * `log` 省略時 (= 純粋なカタログ取得) は警告を出さず filter だけ行う。
 */
export function loadLocalCatalog(
  problemsDir: string,
  fs: CatalogFs,
  log?: (line: string) => void,
): LocalCatalogProblem[] {
  const all = readAllProblems(problemsDir, fs);
  const solvable = all.filter((p) => p.scoringKind === LOCAL_SOLVABLE_KIND);
  const hidden = all.filter((p) => p.scoringKind !== LOCAL_SOLVABLE_KIND);
  if (log && hidden.length > 0) {
    const ids = hidden.map((p) => p.problemId).join(", ");
    log(`${hidden.length} problems hidden in local mode (need AWS deploy: ${ids})`);
  }
  return solvable;
}

/** 1 problem を id で解決する。 `local up <challenge>` の絞り込みに使う。 */
export function findProblem(
  catalog: readonly LocalCatalogProblem[],
  problemId: string,
): LocalCatalogProblem | undefined {
  return catalog.find((p) => p.problemId === problemId);
}

/**
 * local mode の練習用 flag。 deploy 由来の per-team random flag (TC{FlagSeed}) は local には
 * 無いため、 problemId から決定的に導出する。 不正防止は #1975 の非目標なので公開してよい。
 */
export function localPracticeFlag(problemId: string): string {
  return `TC{local-${problemId}}`;
}
