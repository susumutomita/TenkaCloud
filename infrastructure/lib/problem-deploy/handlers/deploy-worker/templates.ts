import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_ROOT = path.resolve(__dirname, "problems");

const cache = new Map<string, string>();

/**
 * Lambda asset の `problems/` から問題 CFn テンプレートを読む。Lambda コンテナの
 * 寿命中は内容不変なので一度読んだら module-scope cache に保持する。
 *
 * テストで `rootDir` を渡すと cache を bypass して新しい root を見にいく
 * (試験ごとに別 fixture を読みたいケース用)。
 */
export function loadProblemTemplate(problemId: string, rootDir: string = DEFAULT_ROOT): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(problemId)) {
    throw new Error(`invalid problemId: ${problemId}`);
  }
  if (rootDir === DEFAULT_ROOT) {
    const cached = cache.get(problemId);
    if (cached) return cached;
  }
  const categories = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const category of categories) {
    const candidate = path.join(rootDir, category, problemId, "template.yaml");
    if (fs.existsSync(candidate)) {
      const body = fs.readFileSync(candidate, "utf8");
      if (rootDir === DEFAULT_ROOT) cache.set(problemId, body);
      return body;
    }
  }
  throw new Error(`template not found for problemId=${problemId} under ${rootDir}`);
}
