import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `problems/<category>/<id>/metadata.json` を持つディレクトリを列挙し、
 * `{ [problemId]: "problems/<category>/<id>" }` の map を返す。frontend の Vite glob と
 * 同じ正本 (filesystem) から問題カタログを引くためのヘルパー。
 *
 * - `problemsRoot` が存在しない / metadata.json が無い場合は空 map を返す (synth 時に
 *   problems/ を埋める前に typecheck が走るケースの防御)
 * - id は metadata.json の `id` field を採用 (ディレクトリ名と一致するのは規約だが、
 *   一致しない場合は metadata 側を信用する)
 *
 * Phase 2 (ADR-003) で DDB ベースの問題カタログに置換されるまでの自動 discovery 経路。
 */
export function discoverProblemsCatalog(problemsRoot: string): Record<string, string> {
  if (!fs.existsSync(problemsRoot)) {
    console.warn(
      `[discoverProblemsCatalog] ${problemsRoot} not found — assuming pre-install or wrong cwd. ` +
        `Catalog will be empty; tenant API will reject all problemId.`,
    );
    return {};
  }
  const catalog: Record<string, string> = {};
  for (const category of fs.readdirSync(problemsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(problemsRoot, category.name);
    for (const problem of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!problem.isDirectory()) continue;
      const metadataPath = path.join(categoryDir, problem.name, "metadata.json");
      if (!fs.existsSync(metadataPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { id?: unknown };
        if (typeof meta.id !== "string" || meta.id.length === 0) {
          console.warn(`[discoverProblemsCatalog] ${metadataPath}: missing or invalid 'id' field`);
          continue;
        }
        catalog[meta.id] = `problems/${category.name}/${problem.name}`;
      } catch (err) {
        console.warn(
          `[discoverProblemsCatalog] ${metadataPath}: parse failed (${(err as Error).message}). ` +
            `Run 'make validate-problems' to see schema errors.`,
        );
      }
    }
  }
  return catalog;
}
