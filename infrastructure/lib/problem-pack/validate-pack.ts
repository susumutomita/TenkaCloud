/**
 * [Problem Packs / Issue #2088 → #2106] Standalone, offline pack validator.
 *
 * `validatePackDirectory` moved into `@tenkacloud/problem-sdk` (single source of
 * truth, also the public authoring contract) and is re-exported here — together
 * with its result/diagnostic types and the manifest filename constant — with
 * identical names and signatures so existing callers (pack-cli, snapshot,
 * lifecycle) compile unchanged.
 */

export {
  PACK_MANIFEST_FILENAME,
  type PackValidationResult,
  validatePackDirectory,
} from "@tenkacloud/problem-sdk/internal";
