import { resolve } from "node:path";
import { build } from "esbuild";
import { LAMBDA_EXTERNAL_MODULES } from "../../lib/utils/lambda-runtime";

export interface RuntimeBundleInspection {
  readonly bytes: number;
  readonly inputs: readonly string[];
}

/** Bundle a Lambda entrypoint with the same production-relevant esbuild settings used by guards. */
export async function inspectRuntimeBundle(entry: string): Promise<RuntimeBundleInspection> {
  const result = await build({
    entryPoints: [resolve(import.meta.dirname, entry)],
    bundle: true,
    metafile: true,
    minify: true,
    platform: "node",
    target: "node22",
    write: false,
    outfile: "index.js",
    // Issue #2864: `defineNodejsFunction` の `externalModules` と同じ定数を参照し、
    // 実 bundling とガードの設定ドリフトを防ぐ。
    external: [...LAMBDA_EXTERNAL_MODULES],
  });

  const output = result.outputFiles?.find((file) => file.path.endsWith("index.js"));
  if (!output) {
    throw new Error(`esbuild did not emit index.js for ${entry}`);
  }

  return {
    bytes: output.contents.byteLength,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}
