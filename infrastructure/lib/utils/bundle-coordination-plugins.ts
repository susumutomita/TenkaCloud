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
/**
 * [Issue #3154] What a coordination plugin is allowed to **link**.
 *
 * Plugin bundles are executed by the dispatcher Lambda, and on the Turso backend
 * that Lambda holds `ssm:GetParameter` for the control-data auth token
 * (`grantTursoAuthTokenRead`). A plugin that reaches the AWS SDK can read that
 * token and then read and write EVERY tenant's control data.
 *
 * That is not hypothetical. A probe placed in a real problem's `coordination/`
 * directory importing `@aws-sdk/client-ssm` bundled cleanly — 1.5 MB, 55
 * references to `SSMClient` — because `bundle: true` resolves bare specifiers up
 * through the repository's `node_modules` from wherever the entry point sits.
 * This allowlist closes that: the SDK can no longer be linked into a bundle.
 *
 * **It is not an isolation boundary, and must not be read as one.** Two probes,
 * both measured against this check, bundle clean today:
 *
 *   - Ambient globals. `fetch("https://…", { body: JSON.stringify(process.env) })`
 *     has no imports at all, so it has no metafile edges to inspect — and a
 *     Lambda's `process.env` carries `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
 *     / `AWS_SESSION_TOKEN`, i.e. the same credentials by a shorter route.
 *   - Computed dynamic import. `await import(parts.join(""))` leaves no literal
 *     specifier for esbuild to record, and the Node Lambda runtime ships an AWS
 *     SDK for it to resolve against.
 *
 * Scanning the source for `process` or `fetch` would not help either:
 * `globalThis["pro" + "cess"]` defeats it in one line, and a guard that reads
 * like a boundary while not being one is worse than none. The real boundary is
 * privilege — the dispatcher not holding credentials a plugin could want, or
 * plugins running somewhere that does not — and that is infrastructure work
 * tracked on #3154, not something a bundler can do.
 *
 * What this check buys is the cheap half: the accidental and the lazy path is
 * shut, it fails synth rather than the match, and it costs nothing at runtime.
 *
 * `node:crypto` is allowed because problem seed derivation uses it and
 * `platform: "node"` leaves it external; the dispatcher Lambda already loads it.
 */
const ALLOWED_PLUGIN_IMPORTS: readonly string[] = [
  "@tenkacloud/coordination-plugin-sdk",
  "node:crypto",
];

/**
 * Fails the build when any file reachable from the plugin imports a package
 * outside {@link ALLOWED_PLUGIN_IMPORTS}.
 *
 * Reads the metafile rather than an esbuild `onResolve` hook because
 * `buildSync` rejects plugins outright ("Cannot use plugins in synchronous API
 * calls") and synth is synchronous. The metafile covers the whole reachable
 * graph, so a forbidden import is caught wherever it hides — including in a file
 * the plugin only reaches transitively through the problem's own game logic.
 *
 * `imports[].original` is the specifier as written and is present only when
 * esbuild rewrote it to a resolved path; for an external such as `node:crypto`
 * the raw specifier stays in `path`. Taking `original ?? path` therefore yields
 * what the source actually wrote in both cases, which keeps this check
 * independent of where `problemsRoot` sits on disk.
 */
function assertPluginImportsAllowed(problemId: string, metafile: BundleMetafile): void {
  const violations: { file: string; specifier: string }[] = [];
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      const specifier = imported.original ?? imported.path;
      // Relative and absolute specifiers are the plugin's own files, which
      // `bundle: true` exists to inline.
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (ALLOWED_PLUGIN_IMPORTS.includes(specifier)) continue;
      violations.push({ file, specifier });
    }
  }
  if (violations.length === 0) return;
  // Report a line the author actually wrote. One forbidden package drags in
  // hundreds of its own internals, and naming a transitive `node:stream` deep
  // inside `@smithy/core` sends the reader to the wrong file.
  const authored = violations.filter((v) => !v.file.includes("node_modules/"));
  const { file, specifier } = (authored[0] ?? violations[0]) as { file: string; specifier: string };
  const rest = violations.length - 1;
  throw new Error(
    `coordination plugin "${problemId}" imports "${specifier}" (in ${file}), which is not allowed. ` +
      `A plugin runs inside the dispatcher Lambda, which holds credentials for every tenant's ` +
      `control data, so it may import only ${ALLOWED_PLUGIN_IMPORTS.join(" / ")} plus its own files. ` +
      (rest > 0 ? `${rest} further disallowed import(s) came in with it. ` : "") +
      `See infrastructure/lib/utils/bundle-coordination-plugins.ts (Issue #3154).`,
  );
}

/** The slice of esbuild's metafile {@link assertPluginImportsAllowed} reads. */
interface BundleMetafile {
  readonly inputs: Record<
    string,
    { readonly imports: readonly { readonly path: string; readonly original?: string }[] }
  >;
}

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
      // [Issue #3154] The metafile is what the import allowlist is checked against.
      metafile: true,
    });
    assertPluginImportsAllowed(problemId, result.metafile);
    out[problemId] = result.outputFiles[0].text;
  }
  return out;
}
