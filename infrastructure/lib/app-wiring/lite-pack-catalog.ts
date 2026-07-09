import * as fs from "node:fs";
import * as path from "node:path";
import type { PackAsset } from "../app-config/types.js";
import type { CatalogSource } from "../problem-pack/catalog-source.js";
import { ActivationStore, tenantCatalogSource } from "../problem-pack/pack-activation.js";

/**
 * [Issue #2459] Resolve the Lite catalog source + pack assets from the local activation store,
 * when one exists.
 *
 * Extracted out of `bin/tenkacloud-lite.ts` (was the module-private `resolveLiteCatalog`) so the
 * bin's catalog glue has direct unit coverage instead of only being reachable through a full CDK
 * app synth. The bin now just calls this and passes the result straight through — byte-identical
 * behavior, CFn NO-OP.
 *
 * Both are read from the SAME `ActivationStore` for the `local` tenant (#2462): the catalog source
 * lifts active pack problems into the effective catalog, and the pack assets are the on-disk
 * snapshots those catalog keys resolve to. Reading one store keeps the two consistent. Absent store
 * → undefined = the default core-only path (byte-identical synth, no pack materialization).
 */
export function resolveLitePackCatalog(
  binDir: string,
): { catalogSource: CatalogSource; packAssets: readonly PackAsset[] } | undefined {
  const packStoreDir = path.resolve(binDir, "..", "..", ".tenkacloud", "pack-store");
  if (!fs.existsSync(packStoreDir)) return undefined;
  const store = new ActivationStore(packStoreDir);
  return {
    catalogSource: tenantCatalogSource(store, "local"),
    packAssets: store.packAssetsForTenant("local"),
  };
}
