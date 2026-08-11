import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import {
  discoverProblemsCatalog,
  discoverProblemsCoordination,
} from "./discover-problems-catalog.js";

/**
 * Issue #1420: synth 時に各問題の coordination plugin を **self-contained ESM (.mjs)** に
 * bundle する。 plugin が import する `@tenkacloud/coordination-plugin-sdk` を inline し、 dispatcher
 * Lambda が S3 から download → `import()` するだけで実行できる形にする (= 動的 load、 platform 再
 * デプロイ不要)。
 *
 * 返り値は `{ [problemId]: bundledJs }`。 CoordinationPluginBundle 構築子が staging dir に書き出し
 * BucketDeployment で S3 へ上げる。 bundle 失敗 (= plugin の構文/依存エラー) は throw して synth を
 * 止める (= 壊れた plugin を catalog に載せたまま deploy させない)。
 */
export function bundleCoordinationPlugins(problemsRoot: string): Record<string, string> {
  const catalog = discoverProblemsCatalog(problemsRoot);
  const coordination = discoverProblemsCoordination(problemsRoot);
  const out: Record<string, string> = {};
  for (const [problemId, { plugin }] of Object.entries(coordination)) {
    const dir = catalog[problemId];
    if (!dir) continue;
    // discoverProblemsCatalog は repo-root 相対の `problems/<category>/<dir>` を返すため、
    // 先頭の `problems/` を外して problemsRoot 配下へ join する (= problemsRoot の basename 非依存)。
    const relToRoot = dir.replace(/^problems\//, "");
    const entry = join(problemsRoot, relToRoot, plugin);
    if (!existsSync(entry)) continue;
    const result = buildSync({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      // 純 reducer 規約 (validate-problems で enforce 済) のため外部依存は SDK のみ。
      // SDK を inline して self-contained にする (= Lambda の module graph に依存しない)。
      write: false,
      logLevel: "silent",
      legalComments: "none",
    });
    out[problemId] = result.outputFiles[0].text;
  }
  return out;
}
