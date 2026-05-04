import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Lambda 実行環境で `problems/` ディレクトリ (CDK の bundling.commandHooks で同梱) から
 * 問題 CFn テンプレートを読む。problemId からどの category 配下にあるかを検索して
 * `template.yaml` の中身を返す。
 *
 * テスト時は `rootDir` を渡して repository root を指定する。
 */

const DEFAULT_ROOT = path.resolve(__dirname, "problems");

export function loadProblemTemplate(problemId: string, rootDir: string = DEFAULT_ROOT): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(problemId)) {
    throw new Error(`invalid problemId: ${problemId}`);
  }
  const categories = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const category of categories) {
    const candidate = path.join(rootDir, category, problemId, "template.yaml");
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  throw new Error(`template not found for problemId=${problemId} under ${rootDir}`);
}
