/**
 * [Issue #2527 Slice 3] Compatibility barrel over the per-aggregate mirror
 * adapters (formerly one 1,272-line file). Each `Mirrored*Repository` now lives
 * in `mirrored-<aggregate>-repository.ts`; this barrel keeps the existing
 * import sites compiling. New code should import from the specific module.
 */

export { MirroredAdminAuditLogRepository } from "./mirrored-admin-audit-log-repository.js";
export { MirroredCompetitorAccountsRepository } from "./mirrored-competitor-accounts-repository.js";
export { MirroredDeploymentsRepository } from "./mirrored-deployments-repository.js";
export { MirroredDisruptionsRepository } from "./mirrored-disruptions-repository.js";
export { MirroredEventsRepository } from "./mirrored-events-repository.js";
export { MirroredFeatureFlagsRepository } from "./mirrored-feature-flags-repository.js";
export { MirroredNotificationsRepository } from "./mirrored-notifications-repository.js";
export { MirroredProblemEndpointsRepository } from "./mirrored-problem-endpoints-repository.js";
export { MirroredSamlConfigRepository } from "./mirrored-saml-config-repository.js";
export { MirroredSamlIdpsRepository } from "./mirrored-saml-idps-repository.js";
export { MirroredTeamsRepository } from "./mirrored-teams-repository.js";
