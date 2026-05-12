import * as fs from "node:fs";
import * as path from "node:path";
import { type ProblemEndpointSlot, parseEndpointSlot } from "./endpoints-metadata";
import { type ProblemScoringMetadata, parseScoringMetadata } from "./scoring-metadata";

export type { ProblemEndpointSlot, ProblemScoringMetadata };

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
 * `discoverProblemsCatalog` の sibling。同じ走査で `scoring` section を抜き、
 * `{ [problemId]: ProblemScoringMetadata }` の map を返す。`scoring` を持たない
 * 問題はキーごと出さない (= scoring 無効)。
 *
 * Lambda env vars (`BATTLE_PROBLEMS_SCORING`) として deploy-handler / participant-
 * handler に渡し、両 Lambda が同じ scoring 規則を共有する。
 */
export function discoverProblemsScoring(
  problemsRoot: string,
): Record<string, ProblemScoringMetadata> {
  const result: Record<string, ProblemScoringMetadata> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    const cfg = parseScoringMetadata(meta.scoring);
    if (cfg) result[meta.id] = cfg;
  }
  return result;
}

/**
 * `discoverProblemsCatalog` の sibling (ADR-012 Phase 3.A)。`endpoints[]` section を抜き、
 * `{ [problemId]: ProblemEndpointSlot[] }` の map を返す。`endpoints` を持たない問題は
 * キーごと出さない (= endpoint 無効、Challenge 系 flag-only 問題が該当)。
 *
 * Lambda env (`PROBLEM_ENDPOINTS`) として Participant Portal handler / scoring dispatcher
 * に渡し、各 Lambda が default URL を CFn output から read-through 算出する。
 */
export function discoverProblemsEndpoints(
  problemsRoot: string,
): Record<string, readonly ProblemEndpointSlot[]> {
  const result: Record<string, readonly ProblemEndpointSlot[]> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (!Array.isArray(meta.endpoints)) continue;
    const slots: ProblemEndpointSlot[] = [];
    for (const entry of meta.endpoints) {
      const slot = parseEndpointSlot(entry);
      if (slot) slots.push(slot);
    }
    if (slots.length > 0) result[meta.id] = slots;
  }
  return result;
}

/**
 * `discoverProblemsCatalog` の sibling (ADR-012 Phase 3.B)。`phases[]` section を抜き、
 * `{ [problemId]: PhaseEntry[] }` の map を返す。`phases` を持たない問題はキーごと出さない。
 *
 * `phased-polling` kind の dispatcher が time-based rule 切替に参照する。CDK synth 時に
 * metadata.json を走査し、Lambda 起動時 (`BATTLE_PROBLEMS_PHASES` env) に再度 file IO せず
 * 単一 JSON 文字列で受け取る (= cold start 削減)。
 */
export interface ProblemPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
  readonly description?: string;
}

export function discoverProblemsPhases(
  problemsRoot: string,
): Record<string, readonly ProblemPhaseEntry[]> {
  const result: Record<string, readonly ProblemPhaseEntry[]> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (!Array.isArray(meta.phases)) continue;
    const phases: ProblemPhaseEntry[] = [];
    for (const entry of meta.phases) {
      const phase = parsePhaseEntry(entry);
      if (phase) phases.push(phase);
    }
    if (phases.length > 0) result[meta.id] = phases;
  }
  return result;
}

function parsePhaseEntry(value: unknown): ProblemPhaseEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    name?: unknown;
    afterMinutes?: unknown;
    effect?: unknown;
    description?: unknown;
  };
  if (typeof v.name !== "string" || typeof v.afterMinutes !== "number") return undefined;
  const effectInput =
    v.effect && typeof v.effect === "object" ? (v.effect as Record<string, unknown>) : undefined;
  const effect = effectInput
    ? {
        ...(typeof effectInput.scorePathOverride === "string"
          ? { scorePathOverride: effectInput.scorePathOverride }
          : {}),
        ...(Array.isArray(effectInput.switchPlatformToDegraded)
          ? {
              switchPlatformToDegraded: effectInput.switchPlatformToDegraded.filter(
                (s): s is string => typeof s === "string",
              ),
            }
          : {}),
      }
    : undefined;
  return {
    name: v.name,
    afterMinutes: v.afterMinutes,
    ...(effect ? { effect } : {}),
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };
}

interface ProblemMetadataEntry {
  id: string;
  category: string;
  dirName: string;
  scoring: unknown;
  endpoints: unknown;
  phases: unknown;
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
      if (!fs.existsSync(metadataPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
          id?: unknown;
          scoring?: unknown;
          endpoints?: unknown;
          phases?: unknown;
        };
        if (typeof meta.id !== "string" || meta.id.length === 0) {
          console.warn(`[discoverProblemsCatalog] ${metadataPath}: missing or invalid 'id' field`);
          continue;
        }
        yield {
          id: meta.id,
          category: category.name,
          dirName: problem.name,
          scoring: meta.scoring,
          endpoints: meta.endpoints,
          phases: meta.phases,
        };
      } catch (err) {
        console.warn(
          `[discoverProblemsCatalog] ${metadataPath}: parse failed (${(err as Error).message}). ` +
            `Run 'make validate-problems' to see schema errors.`,
        );
      }
    }
  }
}
