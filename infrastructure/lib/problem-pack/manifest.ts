/**
 * [Problem Packs / Issue #2087 → #2106] `tenkacloud-pack.json` manifest contract.
 *
 * The schema, pure parser, and SemVer-range matcher now live in the public
 * `@tenkacloud/problem-sdk` package, which is the single source of truth shared by
 * Core and external Pack authors. This module re-exports them (via the Core-only
 * `/internal` entrypoint) with identical names and signatures so every existing
 * importer (validate-pack, effective-catalog, lifecycle, init-pack, pack-cli)
 * compiles unchanged.
 */

export type { PackManifest, ProviderEngineCapability } from "@tenkacloud/problem-sdk/internal";
export {
  PACK_PROVIDERS,
  parsePackManifest,
  satisfiesCoreRange,
} from "@tenkacloud/problem-sdk/internal";
