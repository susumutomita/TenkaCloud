/**
 * [Problem Packs / Issue #2088 → #2106] Metadata-section validation for the pack
 * validator.
 *
 * Moved into `@tenkacloud/problem-sdk` (single source of truth) and re-exported
 * here unchanged so `validate-pack.ts` keeps the same `validateMetadataSections` /
 * `ProblemMetadataView` contract.
 */

export {
  type ProblemMetadataView,
  validateMetadataSections,
} from "@tenkacloud/problem-sdk/internal";
