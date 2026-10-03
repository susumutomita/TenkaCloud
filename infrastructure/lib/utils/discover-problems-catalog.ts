import * as fs from "node:fs";
import * as path from "node:path";
import {
  isExecutableRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import {
  type DisruptionAction,
  type DisruptionActionKind,
  type DisruptionEffect,
  type DisruptionTrigger,
  type ProblemDisruptionEntry,
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
} from "./metadata-parser.js";

// metadata-parser.ts に移した pure parser / 型は、 従来 import 元 (この catalog file) から
// 引き続き import できるよう re-export する (= 既存 importer の互換維持)。
export {
  type DisruptionAction,
  type DisruptionActionKind,
  type DisruptionEffect,
  type DisruptionTrigger,
  type ProblemDisruptionEntry,
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
};

/**
 * `problems/<category>/<id>/metadata.json` を持つディレクトリを列挙し、
 * `{ [problemId]: "problems/<category>/<id>" }` の map を返す。
 */
export function discoverProblemsCatalog(problemsRoot: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    result[meta.id] = `problems/${meta.category}/${meta.dirName}`;
  }
  return result;
}

/**
 * [#2054] `metadata.runtime` を normalize し、**非 aws/cloudformation の
 * runtime を宣言した問題 id のみ** を map で返す (= container 配信の docker/compose 等)。
 * aws 問題は省略する (= env を最小化、 deploy worker の default fallback がそのまま処理)。
 *
 * Lambda env (`BATTLE_PROBLEMS_RUNTIMES`) として deploy-handler に渡し
 * `resolveProblemRuntime` に配線する。これにより非 AWS 問題は cloud mutation
 * (DDB Put / EventBridge / CFn) より前に `RuntimeNotSupportedError` (= 4xx) で
 * loud に拒否され、 ローカル専用問題のクラウド誤デプロイを防ぐ。
 */
export function discoverProblemsRuntime(
  problemsRoot: string,
): Record<string, ProblemRuntimeDescriptor> {
  const result: Record<string, ProblemRuntimeDescriptor> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    const runtime = normalizeRuntime({
      id: meta.id,
      runtime: meta.runtime,
      cfnTemplate: meta.cfnTemplate,
    });
    if (runtime && !isExecutableRuntime(runtime)) {
      result[meta.id] = runtime;
    }
  }
  return result;
}

/**
 * [#1420] `{ [problemId]: { plugin } }` を返す。 problem が
 * `interTeamCoordination.plugin` (= coordination plugin の module path) を宣言していれば収集する。
 * CoordinationDispatcher Lambda の `PROBLEM_COORDINATION` env へ JSON 化して渡し、 scope resolver が
 * team→moduleRef を解決するのに使う。 宣言の無い問題はキーごと不在 (= coordination 無効)。
 */
export function discoverProblemsCoordination(
  problemsRoot: string,
): Record<string, CoordinationCatalogEntry> {
  const result: Record<string, CoordinationCatalogEntry> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    const coord = meta.interTeamCoordination;
    if (!coord || typeof coord !== "object" || Array.isArray(coord)) continue;
    const plugin = (coord as { plugin?: unknown }).plugin;
    if (typeof plugin === "string" && plugin.length > 0) {
      const stateBudget = parseStateBudget((coord as { stateBudget?: unknown }).stateBudget);
      result[meta.id] = {
        plugin,
        ...(stateBudget ? { stateBudget } : {}),
        scoreMode: meta.scoring == null ? "exclusive" : "additive",
      };
    }
  }
  return result;
}

/**
 * [Issue #3169] 問題が宣言した coordination state の伸び方。
 *
 * `bytesPerTeam x teams + baseBytes` の 2 数だけを運ぶ。 platform 側は
 * `parseCoordinationStateForecast` でもう一度検証してから使うので、 ここは
 * 「壊れた宣言を catalog に載せない」ための足切りに徹する。
 */
export interface CoordinationStateBudgetDeclaration {
  readonly bytesPerTeam: number;
  readonly baseBytes: number;
}

export interface CoordinationCatalogEntry {
  readonly plugin: string;
  /** Derived from the existing ordinary-scoring declaration, never from plugin input. */
  readonly scoreMode?: "exclusive" | "additive";
  readonly stateBudget?: CoordinationStateBudgetDeclaration;
}

/**
 * 両方の数が有効なときだけ宣言として認め、 それ以外は `undefined`。
 *
 * 片方だけ書かれた宣言を半分だけ採用すると、 platform は「宣言がある」と見なして
 * 欠けた側を 0 として扱い、 収まらない event を通してしまう。 未宣言 (= 検査しない)
 * の方が、 半分の宣言で検査したつもりになるより安全。
 */
function parseStateBudget(raw: unknown): CoordinationStateBudgetDeclaration | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { bytesPerTeam, baseBytes } = raw as Record<string, unknown>;
  const validPerTeam =
    typeof bytesPerTeam === "number" && Number.isSafeInteger(bytesPerTeam) && bytesPerTeam > 0;
  const validBase =
    typeof baseBytes === "number" && Number.isSafeInteger(baseBytes) && baseBytes >= 0;
  if (!validPerTeam || !validBase) return undefined;
  return { bytesPerTeam, baseBytes };
}

interface ProblemMetadataEntry {
  id: string;
  category: string;
  dirName: string;
  scoring: unknown;
  endpoints: unknown;
  phases: unknown;
  visibility: unknown;
  disruptions: unknown;
  interTeamCoordination: unknown;
  runtime: unknown;
  cfnTemplate: unknown;
  writeup: unknown;
  i18n: unknown;
}

function* iterateProblemsMetadata(problemsRoot: string): Generator<ProblemMetadataEntry> {
  if (!fs.existsSync(problemsRoot)) {
    console.warn(
      `[discoverProblemsCatalog] ${problemsRoot} not found — assuming pre-install or wrong cwd. ` +
        `Catalog will be empty; tenant API will reject all problemId.`,
    );
    return;
  }
  for (const category of fs.readdirSync(problemsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(problemsRoot, category.name);
    for (const problem of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!problem.isDirectory()) continue;
      const metadataPath = path.join(categoryDir, problem.name, "metadata.json");
      const metadata = readProblemMetadata(metadataPath, category.name, problem.name);
      if (metadata) yield metadata;
    }
  }
}

function readProblemMetadata(
  metadataPath: string,
  category: string,
  dirName: string,
): ProblemMetadataEntry | undefined {
  if (!fs.existsSync(metadataPath)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
      id?: unknown;
      scoring?: unknown;
      endpoints?: unknown;
      phases?: unknown;
      visibility?: unknown;
      disruptions?: unknown;
      interTeamCoordination?: unknown;
      runtime?: unknown;
      cfnTemplate?: unknown;
      writeup?: unknown;
      i18n?: unknown;
    };
    if (typeof meta.id !== "string" || meta.id.length === 0) {
      console.warn(`[discoverProblemsCatalog] ${metadataPath}: missing or invalid 'id' field`);
      return undefined;
    }
    return {
      id: meta.id,
      category,
      dirName,
      scoring: meta.scoring,
      endpoints: meta.endpoints,
      phases: meta.phases,
      visibility: meta.visibility,
      disruptions: meta.disruptions,
      interTeamCoordination: meta.interTeamCoordination,
      runtime: meta.runtime,
      cfnTemplate: meta.cfnTemplate,
      writeup: meta.writeup,
      i18n: meta.i18n,
    };
  } catch (err) {
    console.warn(
      `[discoverProblemsCatalog] ${metadataPath}: parse failed (${(err as Error).message}). ` +
        `Run 'make validate-problems' to see schema errors.`,
    );
    return undefined;
  }
}
