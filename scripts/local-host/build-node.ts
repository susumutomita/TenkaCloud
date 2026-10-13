import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const directory = resolve(".tenkacloud/node-host");
await mkdir(directory, { recursive: true });
await build({
  entryPoints: {
    index: "scripts/local-host/node-main.ts",
    browser: "scripts/local-host/tests/e2e-host.ts",
    state: "scripts/local-host/tests/node-state.test-helpers.ts",
  },
  outdir: directory,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  plugins: [
    {
      name: "bundle-workspace-sources",
      setup(bundler) {
        bundler.onResolve({ filter: /^[^./]/ }, ({ path }) =>
          path.startsWith("@tenkacloud/") || path.startsWith("@TenkaCloud/")
            ? undefined
            : { path, external: true },
        );
      },
    },
  ],
  external: ["bun:sqlite"],
});
console.log(`Built ${directory}/index.mjs; run from the repository root with Node 24.`);
