/**
 * [Issue #2527 Slice 1] Temporary compatibility barrel over the per-aggregate
 * domain modules.
 *
 * The former 1,662-line all-aggregate types file is split one-module-per-aggregate
 * under `./domain/` (events / teams / deployments / notifications / feature-flags /
 * problem-endpoints / competitor-accounts / saml-config / disruptions / admin-audit /
 * saml-idps), plus the adapter-facing SQL executor port in `./sql-port.ts`.
 *
 * This barrel exists ONLY so the ~60 existing consumers keep compiling while they
 * migrate to direct imports. Do not add new exports here; new code must import from
 * the specific module. Deletion condition: once no file imports from
 * `control-data/types.js`, delete this barrel (tracked by #2527 Slice 1).
 */

export type * from "./domain/admin-audit.js";
export type * from "./domain/competitor-accounts.js";
export type * from "./domain/deployments.js";
export type * from "./domain/disruptions.js";
export type * from "./domain/events.js";
export type * from "./domain/feature-flags.js";
export type * from "./domain/notifications.js";
export type * from "./domain/problem-endpoints.js";
export type * from "./domain/saml-config.js";
export type * from "./domain/saml-idps.js";
export type * from "./domain/teams.js";
export type * from "./sql-port.js";
