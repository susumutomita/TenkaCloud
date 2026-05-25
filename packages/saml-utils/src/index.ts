/**
 * @tenkacloud/saml-utils — shared SAML metadata validation, attribute mapping,
 * and types for Control Plane (#1293) and Application Plane (#1294) SSO.
 *
 * Browser-safe (no Node-only imports). Used by:
 *   - infrastructure/lib/control-plane/handlers/idp-handler (Node Lambda)
 *   - infrastructure/lib/tenant-template/handlers/idp-handler (Node Lambda)
 *   - apps/admin-console (SAML metadata client-side preview)
 *   - apps/application-admin-console (SAML metadata client-side preview)
 */

export type { AttributeMapperInput } from "./attribute-mapper.js";
export {
  buildApplicationPlaneUserPk,
  buildControlPlaneUserPk,
  buildIdentityClaim,
  resolveRoles,
} from "./attribute-mapper.js";
export type {
  SamlMetadataValidationFailure,
  SamlMetadataValidationResult,
} from "./metadata.js";
export {
  DEFAULT_ATTRIBUTE_MAPPING,
  SAML_IDP_LIMIT_PER_USERPOOL,
  SAML_METADATA_MAX_BYTES,
  toCognitoProviderDetails,
  validateSamlMetadata,
} from "./metadata.js";
export type {
  CreateIdpInput,
  UpdateIdpInput,
} from "./schema.js";
export {
  CreateIdpInputSchema,
  GroupToRoleSchema,
  IdpIdSchema,
  PLATFORM_ROLES,
  PlatformRoleSchema,
  SamlAttributeMappingSchema,
  UpdateIdpInputSchema,
} from "./schema.js";
export type {
  PlatformRole,
  SamlAttributeMapping,
  SamlIdentityClaim,
  SamlIdpConfig,
} from "./types.js";
