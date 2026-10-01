import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEndpointSlot } from "../../packages/problem-sdk/src/endpoints-metadata";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const reviewedNonDockerPaths = [
  "challenges/hello-world",
  "battles/ac26-crypto-battle",
  "battles/hello-world-battle",
] as const;
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
    ...reviewedNonDockerPaths,
    ...dockerBrowserPaths(root, "challenges"),
    ...dockerBrowserPaths(root, "battles"),
  ];
  const result = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  if (root === repositoryRoot) cachedBrowserPaths = result;
  return result;
}

/** Build-time allowlist, not runtime tree-shaking: never ship author metadata,
 * hint content, answers, writeups or pre-start instructions to a hosting browser. */
export function publicMetadata(code: string, id: string): string | null {
  if (!/[/\\]problems[/\\][^/\\]+[/\\][^/\\]+[/\\]metadata\.json(?:\?.*)?$/u.test(id)) return null;
  const raw = JSON.parse(code) as Record<string, unknown>;
  const runtime =
    raw.runtime && typeof raw.runtime === "object" ? (raw.runtime as Record<string, unknown>) : {};
  const i18n =
    raw.i18n && typeof raw.i18n === "object" ? (raw.i18n as Record<string, unknown>) : {};
  const english =
    i18n.en && typeof i18n.en === "object" ? (i18n.en as Record<string, unknown>) : {};
  return JSON.stringify({
    id: raw.id,
    name: raw.name,
    // Four legacy local exercises are authored under battles/, but their verifier
    // contract is an independent per-team Challenge, not inter-team coordination.
    category: dockerChallenge(raw) ? "Challenge" : raw.category,
    status: raw.status,
    visibility: raw.visibility,
    difficulty: raw.difficulty,
    estimatedDuration: raw.estimatedDuration,
    shortDescription: raw.shortDescription,
    learningGoals: [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    runtime:
      raw.id === "ac26-crypto-battle"
        ? { provider: "local", engine: "bun" }
        : { provider: runtime.provider, engine: runtime.engine },
    ...(raw.id === "ac26-crypto-battle"
      ? { dashboard: raw.dashboard, interTeamCoordination: raw.interTeamCoordination }
      : {}),
    ...(raw.id === "hello-world-battle" ? { endpoints: publicEndpointSlots(raw.endpoints) } : {}),
    i18n: { en: { name: english.name, shortDescription: english.shortDescription } },
  });
}

function publicEndpointSlots(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Reviewed Battle endpoints are missing.");
  return value.map((entry) => {
    const endpoint = parseEndpointSlot(entry);
    if (!endpoint) throw new Error("Reviewed Battle endpoint is invalid.");
    return { slot: endpoint.slot, default: endpoint.default, overridable: endpoint.overridable };
  });
}

export function narrowCatalog(code: string, id: string): string | null {
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
  const publicPaths = hostBrowserProblemPaths().join(",");
  const narrowed = code.replace(glob, (_match, suffix: string) => {
    if (suffix === "portal/*.tsx") return "problems/battles/ac26-crypto-battle/portal/*.tsx";
    if (suffix === "*.yaml") return "problems/challenges/sqli-demo/__local_host_empty__/*.yaml";
    return `problems/{${publicPaths}}/${suffix}`;
  });
  if (narrowed.includes("problems/*/*/"))
    throw new Error("An unreviewed catalog discovery pattern remains in the hosting build.");
  return narrowed.replace(
    /"(?:\.\.\/)+\.tenkacloud\/pack-store\/snapshots\/[^"\n]+"/gu,
    '"../../../../problems/challenges/sqli-demo/__local_host_empty__/**/*"',
  );
}
/** Defense in depth against changed globs: inspect the actual bundled module
 * graph as well as transforming the known catalog discovery expressions. */
export function assertHostingModule(id: string): void {
  const normalized = id.replaceAll("\\", "/");
  if (normalized.includes("/.tenkacloud/pack-store/"))
    throw new Error("Installed pack content cannot enter a local-host browser bundle.");
  if (!normalized.includes("/problems/")) return;
  if (
    /\/problems\/battles\/ac26-crypto-battle\/(?:metadata\.json|diagram(?:\.en)?\.svg|portal\/[^/]+\.(?:tsx?|css)|game\/src\/[^/]+\.ts)(?:\?.*)?$/u.test(
      normalized,
    )
  ) {
    if (/\/game\/src\/(?:reducer|fixtures|prng|secret|seed)/u.test(normalized))
      throw new Error(`Server-only game code entered the browser: ${id}`);
    return;
  }
  const publicFile =
    /\/problems\/((?:challenges|battles)\/[^/]+)\/(?:metadata\.json|diagram(?:\.en)?\.svg)(?:\?.*)?$/u.exec(
      normalized,
    );
  if (publicFile?.[1] && hostBrowserProblemPaths().includes(publicFile[1])) return;
  throw new Error(`Unreviewed problem content entered the hosting bundle: ${id}`);
}
