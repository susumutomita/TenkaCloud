/**
 * Zod schemas for the IdP CRUD API request bodies (Issues #1293 / #1294).
 *
 * Each handler (Control Plane / Application Plane) reuses these to validate
 * inputs at the API boundary before touching Cognito or DDB.
 */

import { z } from "zod";
import type { PlatformRole } from "./types.js";

const PLATFORM_ROLES: readonly PlatformRole[] = [
  "SystemAdmin",
  "TenantAdmin",
  "Operator",
  "Viewer",
] as const;

export const PlatformRoleSchema = z.enum(["SystemAdmin", "TenantAdmin", "Operator", "Viewer"]);

/**
 * The `idpId` is also used as the Cognito `ProviderName`. Cognito constraint:
 * 3-32 chars, [\w_]+ (we additionally allow `-`). We always lowercase before
 * storing.
 */
export const IdpIdSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const SamlAttributeMappingSchema = z
  .object({
    email: z.string().min(1),
    displayName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .strict();

export const GroupToRoleSchema = z.record(PlatformRoleSchema);

export const CreateIdpInputSchema = z
  .object({
    idpId: IdpIdSchema,
    displayName: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
    metadataXml: z.string().min(1),
    attributeMapping: SamlAttributeMappingSchema,
    groupToRole: GroupToRoleSchema,
  })
  .strict();

export const UpdateIdpInputSchema = z
  .object({
    displayName: z.string().min(1).max(80).optional(),
    description: z.string().max(280).optional(),
    metadataXml: z.string().min(1).optional(),
    attributeMapping: SamlAttributeMappingSchema.optional(),
    groupToRole: GroupToRoleSchema.optional(),
  })
  .strict();

export type CreateIdpInput = z.infer<typeof CreateIdpInputSchema>;
export type UpdateIdpInput = z.infer<typeof UpdateIdpInputSchema>;

export { PLATFORM_ROLES };
