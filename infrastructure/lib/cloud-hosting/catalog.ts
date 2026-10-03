import type { ProblemsCatalogBundle } from "../../../scripts/problem-pack/catalog-types.js";

/** Docker/Compose exercises belong to the local process and never enter a cloud catalog. */
export function cloudCatalog(bundle: ProblemsCatalogBundle): ProblemsCatalogBundle {
  const runtimes = bundle.runtimes as Readonly<
    Record<
      string,
      {
        provider?: string;
        engine?: string;
        targets?: readonly { provider?: string; engine?: string }[];
      }
    >
  >;
  const excluded = new Set(
    Object.entries(runtimes ?? {})
      .filter(([, runtime]) =>
        [runtime, ...(runtime.targets ?? [])].some(
          (target) => target.provider === "docker" || target.engine === "compose",
        ),
      )
      .map(([id]) => id),
  );
  const filtered = Object.fromEntries(
    Object.entries(bundle).map(([key, projection]) => [
      key,
      Object.fromEntries(
        Object.entries((projection as Record<string, unknown>) ?? {}).filter(
          ([id]) => !excluded.has(id),
        ),
      ),
    ]),
  );
  return filtered as unknown as ProblemsCatalogBundle;
}
