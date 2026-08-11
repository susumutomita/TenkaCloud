import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// No root-level `tsconfig.json` exists in this monorepo — each workspace under
// `apps/` / `infrastructure/` / `packages/` carries its own, and the bundled
// runtime only ever runs `bun run scripts/tenkacloud-lite.ts` (bun transpiles
// `.ts` directly; nothing here invokes `tsc`). Listing it made every assembly
// fail with ENOENT before it ever reached the `packages` root below, so
// `prepack` — and therefore `npm pack` — had never actually succeeded.
export const RUNTIME_ROOTS = [
  "apps",
  "infrastructure",
  "scripts",
  "packages",
  "package.json",
  "bun.lock",
  "Makefile",
  "biome.json",
];

function defaultFilter(candidate) {
  const normalized = candidate.split(path.sep).join("/");
  return (
    !normalized.includes("/node_modules/") &&
    !normalized.includes("/cdk.out/") &&
    !normalized.includes("/dist/") &&
    !normalized.includes("/packages/standalone-cli/runtime")
  );
}

/**
 * Assembles the standalone runtime by copying `roots` from `repositoryRoot` into
 * `runtimeRoot`.
 *
 * `runtimeRoot` normally lives inside this package (`packages/standalone-cli/runtime`),
 * which is itself inside the `packages` root being copied. `node:fs/promises`'s `cp()`
 * refuses outright to copy a directory into any destination nested inside itself —
 * `checkPaths` rejects that before `filter` is ever consulted, so excluding the
 * destination via `filter` (as this function still does, defensively) cannot work
 * around it. Assembling directly into `runtimeRoot` therefore always throws
 * `ERR_FS_CP_EINVAL` on the `packages` root.
 *
 * The fix is the same staging-then-atomic-rename shape `syncProblems()` in
 * `src/runtime.mjs` uses: copy into a temporary directory that is a sibling of the
 * roots being copied (directly under `repositoryRoot`, never inside one of them),
 * then swap it into place. Staging under `repositoryRoot` — not `os.tmpdir()` —
 * keeps the final `rename` on the same filesystem as the checkout, avoiding an
 * `EXDEV` cross-device failure when `/tmp` is a separate mount (common in CI).
 */
export async function assembleRuntime({
  repositoryRoot,
  runtimeRoot,
  roots = RUNTIME_ROOTS,
  filter = defaultFilter,
} = {}) {
  await rm(runtimeRoot, { recursive: true, force: true });

  const stagingRoot = await mkdtemp(path.join(repositoryRoot, ".tenkacloud-runtime-staging-"));

  try {
    for (const relative of roots) {
      const source = path.join(repositoryRoot, relative);
      const destination = path.join(stagingRoot, relative);
      await cp(source, destination, {
        recursive: true,
        dereference: false,
        filter,
      });
    }
    await mkdir(path.dirname(runtimeRoot), { recursive: true });
    await rename(stagingRoot, runtimeRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return runtimeRoot;
}

async function main() {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = path.resolve(packageRoot, "../..");
  const runtimeRoot = path.join(packageRoot, "runtime");
  await assembleRuntime({ repositoryRoot, runtimeRoot });
  console.log(`Assembled standalone runtime at ${runtimeRoot}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
