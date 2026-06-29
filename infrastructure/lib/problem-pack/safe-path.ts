/**
 * [Problem Packs / Issue #2088 → #2106] Safe path resolution + read-only
 * filesystem helpers for the offline pack validator.
 *
 * Moved into `@tenkacloud/problem-sdk` (single source of truth) and re-exported
 * here unchanged so existing importers keep the same helpers.
 */

export {
  isExistingDirectory,
  isInside,
  readDirNames,
  resolveInside,
} from "@tenkacloud/problem-sdk/internal";
