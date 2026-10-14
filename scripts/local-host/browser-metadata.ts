export { publicMetadata } from "./browser-public-metadata";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { selectableProblem } from "../../packages/portal-contracts/src/problem-selection";
import { retainedCatalogRoots, selectedCatalogRoots } from "../problem-pack/catalog-read";
import { reviewedCoordinationPaths } from "./coordination-catalog";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const reviewedNonDockerPaths = [
  "challenges/hello-world",
  ...reviewedCoordinationPaths,
  "battles/hello-world-battle",
] as const;
let selectedBuildRoots: readonly string[] | undefined;
let retainedBuildRoots: readonly string[] | undefined;
function buildRoots(retained: boolean): readonly string[] {
  if (retained) {
    retainedBuildRoots ??= retainedCatalogRoots(repositoryRoot);
    return retainedBuildRoots;
  }
  selectedBuildRoots ??= selectedCatalogRoots(repositoryRoot);
  return selectedBuildRoots;
}
function catalogModuleId(id: string): string {
  return id
    .replace(/\\/gu, "/")
    .replace(
      /\/.tenkacloud\/catalog-store\/snapshots\/[a-f0-9]{64}\/(?:[^?]*?\/)?(challenges|battles)\//u,
      "/problems/$1/",
    );
}
let cachedBrowserPaths: readonly string[] | undefined;

/** Public metadata compatibility, not proof that Docker can execute the problem. */
function dockerChallenge(raw: Record<string, unknown>): boolean {
  const runtime = raw.runtime as Record<string, unknown> | undefined;
  const scoring = raw.scoring as Record<string, unknown> | undefined;
  return (
    runtime?.provider === "docker" &&
    runtime.engine === "compose" &&
    (scoring?.kind === "verify" || scoring?.kind === "multi-verify")
  );
}

function dockerBrowserPaths(root: string, category: string): string[] {
  const paths: string[] = [];
  if (!existsSync(join(root, "problems", category))) return paths;
  for (const entry of readdirSync(join(root, "problems", category), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.name)) continue;
    const raw = JSON.parse(
      readFileSync(join(root, "problems", category, entry.name, "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    if (!dockerChallenge(raw)) continue;
    if (raw.id !== entry.name)
      throw new Error(`Problem identity mismatch: ${category}/${entry.name}`);
    paths.push(`${category}/${entry.name}`);
  }
  return paths;
}

/** Derive the public catalog from runtime contracts; never discover executable portal code. */
export function hostBrowserProblemPaths(root = repositoryRoot): readonly string[] {
  if (root === repositoryRoot && cachedBrowserPaths) return cachedBrowserPaths;
  const paths = [
    ...reviewedNonDockerPaths.filter((path) =>
      existsSync(join(root, "problems", path, "metadata.json")),
    ),
    ...dockerBrowserPaths(root, "challenges"),
    ...dockerBrowserPaths(root, "battles"),
  ];
  const result = [...new Set(paths)]
    .filter((path) => {
      const metadata = JSON.parse(
        readFileSync(join(root, "problems", path, "metadata.json"), "utf8"),
      ) as { id: string; tags?: string[] };
      return selectableProblem(metadata);
    })
    .sort((left, right) => left.localeCompare(right));
  if (root === repositoryRoot) cachedBrowserPaths = result;
  return result;
}

export function narrowCatalog(
  code: string,
  id: string,
  publicProblemPaths?: readonly string[],
): string | null {
  const normalized = id.replaceAll("\\", "/");
  if (
    !normalized.endsWith("/src/data/problems.ts") &&
    !normalized.endsWith("/src/plugins/loader.ts")
  )
    return null;
  const glob =
    /problems\/\*\/\*\/(metadata\.json|diagram(?:\.en)?\.svg|portal\/\*\.tsx|\*\.yaml)/gu;
  if (!glob.test(code))
    throw new Error("The catalog glob changed. Review the hosting bundle before building.");
  // Metadata and diagrams are public projections. Executable plugins remain a
  // separate explicit review boundary, even when their problem is supported.
  const paths = publicProblemPaths ?? hostBrowserProblemPaths();
  const publicPaths =
    paths.length > 1 ? `{${paths.join(",")}}` : (paths[0] ?? "__local_host_empty__");
  const narrowed = code.replace(glob, (_match, suffix: string) => {
    if (suffix === "portal/*.tsx")
      return `problems/{${reviewedCoordinationPaths.join(",")}}/portal/*.tsx`;
    if (suffix === "*.yaml") return "problems/challenges/sqli-demo/__local_host_empty__/*.yaml";
    return `problems/${publicPaths}/${suffix}`;
  });
  if (narrowed.includes("problems/*/*/"))
    throw new Error("An unreviewed catalog discovery pattern remains in the hosting build.");
  const sourced = narrowed.replace(/"(?:\.\.\/)+problems\/([^"\n]+)"/gu, (_match, path: string) => {
    const plugins = path.endsWith("portal/*.tsx");
    const roots = JSON.stringify(
      buildRoots(plugins).map(
        (root) => `${relative(dirname(normalized), root).replaceAll("\\", "/")}/${path}`,
      ),
    );
    return plugins ? `${roots}, { exhaustive: true }` : roots;
  });
  const exhaustive = sourced.replace(/\{\s*(eager|query):/gu, "{ exhaustive: true, $1:");
  return exhaustive.replace(
    /"(?:\.\.\/)+\.tenkacloud\/pack-store\/snapshots\/[^"\n]+"/gu,
    '"../../../../problems/challenges/sqli-demo/__local_host_empty__/**/*"',
  );
}
/** Defense in depth against changed globs: inspect the actual bundled module
 * graph as well as transforming the known catalog discovery expressions. */
export function assertHostingModule(id: string): void {
  const normalized = catalogModuleId(id);
  if (normalized.includes("/.tenkacloud/pack-store/"))
    throw new Error("Installed pack content cannot enter a local-host browser bundle.");
  if (!normalized.includes("/problems/")) {
    if (normalized.includes("/.tenkacloud/catalog-store/"))
      throw new Error(`Unreviewed shared catalog content entered the browser: ${id}`);
    return;
  }
  if (
    /\/problems\/battles\/ac26-crypto-battle\/(?:metadata\.json|diagram(?:\.en)?\.svg|portal\/[^/]+\.(?:tsx?|css)|game\/src\/[^/]+\.ts)(?:\?.*)?$/u.test(
      normalized,
    )
  ) {
    if (/\/game\/src\/(?:reducer|fixtures|prng|secret|seed)/u.test(normalized))
      throw new Error(`Server-only game code entered the browser: ${id}`);
    return;
  }
  if (
    /\/problems\/battles\/pi-siege\/portal\/(?:StatusPanel\.tsx|content(?:\.en)?\.ts|localize\.ts|style\.css)(?:\?.*)?$/u.test(
      normalized,
    )
  )
    return;
  if (
    /\/problems\/battles\/(?:session-defense|tenant-boundary-duel)\/portal\/(?:StatusPanel\.tsx|style\.css)(?:\?.*)?$/u.test(
      normalized,
    )
  )
    return;
  if (
    /\/problems\/battles\/forensic-casebook\/portal\/(?:StatusPanel\.tsx|styles\.ts)(?:\?.*)?$/u.test(
      normalized,
    )
  )
    return;
  const publicFile =
    /\/problems\/((?:challenges|battles)\/[^/]+)\/(?:metadata\.json|diagram(?:\.en)?\.svg)(?:\?.*)?$/u.exec(
      normalized,
    );
  if (publicFile?.[1] && hostBrowserProblemPaths().includes(publicFile[1])) return;
  throw new Error(`Unreviewed problem content entered the hosting bundle: ${id}`);
}
