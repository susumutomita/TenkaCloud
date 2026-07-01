/**
 * [Problem Packs / Issue #2088 → #2106] Shared diagnostic types for the pack
 * validator.
 *
 * Moved into `@tenkacloud/problem-sdk` (single source of truth) and re-exported
 * here unchanged so existing importers keep the same `PackDiagnostic` /
 * `PackDiagnosticCode` contract.
 */

export type { PackDiagnostic, PackDiagnosticCode } from "@tenkacloud/problem-sdk/internal";
