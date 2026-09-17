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
    category: raw.category,
    status: raw.status,
    visibility: raw.visibility,
    difficulty: raw.difficulty,
    estimatedDuration: raw.estimatedDuration,
    shortDescription: raw.shortDescription,
    learningGoals: [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    runtime: { provider: runtime.provider, engine: runtime.engine },
    i18n: { en: { name: english.name, shortDescription: english.shortDescription } },
  });
}

export function narrowCatalog(code: string, id: string): string | null {
  const normalized = id.replaceAll("\\", "/");
  if (
    !normalized.endsWith("/src/data/problems.ts") &&
    !normalized.endsWith("/src/plugins/loader.ts")
  )
    return null;
  const glob = /problems\/\*\/\*\//gu;
  if (!glob.test(code))
    throw new Error("The catalog glob changed. Review the hosting bundle before building.");
  // Include neither other problems' portal code nor author-installed pack snapshots.
  // The reserved empty glob is valid in Vite 7; the module guard rejects any accidental match.
  const narrowed = code.replace(glob, "problems/challenges/sqli-demo/");
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
    !/\/problems\/challenges\/sqli-demo\/(?:metadata\.json|diagram(?:\.en)?\.svg)(?:\?.*)?$/u.test(
      normalized,
    )
  ) {
    throw new Error(`Unreviewed problem content entered the hosting bundle: ${id}`);
  }
}
