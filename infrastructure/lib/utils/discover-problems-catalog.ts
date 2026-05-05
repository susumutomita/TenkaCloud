import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Scoring engine が読む metadata.json の `scoring` section の最低限 shape。
 * SCHEMA.json の oneOf と整合させる。
 */
export type ProblemScoringMetadata =
  | { kind: "flag"; flagOutputKey: string; points: number; hints?: string[] }
  | {
      kind: "uptime";
      endpoints: { outputKey: string; path: string; expectStatus: number[] }[];
      pointsPerSuccess: number;
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
    if (isValidScoring(meta.scoring)) {
      result[meta.id] = meta.scoring;
    }
  }
  return result;
}

interface ProblemMetadataEntry {
  id: string;
  category: string;
  dirName: string;
  scoring: unknown;
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

function isValidScoring(value: unknown): value is ProblemScoringMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") {
    const f = value as { flagOutputKey?: unknown; points?: unknown };
    return typeof f.flagOutputKey === "string" && typeof f.points === "number";
  }
  if (v.kind === "uptime") {
    const u = value as { endpoints?: unknown; pointsPerSuccess?: unknown };
    return Array.isArray(u.endpoints) && typeof u.pointsPerSuccess === "number";
  }
  return false;
}
