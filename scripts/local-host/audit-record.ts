import { z } from "zod";
import type { OrganizerPrincipal } from "./store";

export const auditIdentifierSchema = z.union([
  z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  z.string().uuid(),
]);
export const auditActionSchema = z.enum([
  "audit.enabled",
  "audit.disabled",
  "organizer.bootstrap",
  "organizer.login",
  "organizer.logout",
  "organizer.created",
  "organizer.updated",
  "organizer.deleted",
  "saml.provider_updated",
  "saml.identity_linked",
  "saml.identity_unlinked",
  "feature.updated",
  "competitor_account.registered",
  "competitor_account.verified",
  "competitor_account.deleted",
  "event.created",
  "event.updated",
  "event.deploy",
  "event.teardown",
  "event.ended",
  "event.schedule",
  "event.scoring_lock",
  "team.updated",
  "team.credential_rotated",
  "environment.stop",
  "environment.restart",
  "environment.teardown",
  "disruption.requested",
  "disruption.cancelled",
  "disruption.operation",
  "progression.updated",
  "registration.updated",
  "registration.claimed",
]);
const actorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("host-key"),
      role: z.literal("Admin"),
      authMethod: z.literal("host-key"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("organizer"),
      userId: auditIdentifierSchema,
      role: z.enum(["Admin", "Operator", "Viewer"]),
      authMethod: z.enum(["saml", "local-password"]),
    })
    .strict(),
  z.object({ kind: z.literal("anonymous") }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);
const resourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host") }).strict(),
  z
    .object({
      kind: z.enum(["organizer", "identity", "event", "team", "job", "disruption"]),
      id: auditIdentifierSchema,
    })
    .strict(),
  z.object({ kind: z.literal("account"), id: z.string().regex(/^\d{12}$/u) }).strict(),
  z
    .object({
      kind: z.literal("feature"),
      id: z.enum(["saml", "audit", "challengePrerequisiteGate", "registration"]),
    })
    .strict(),
]);
export const auditRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    phase: z.enum(["request", "result", "cleanup", "recording"]),
    actor: actorSchema,
    action: auditActionSchema,
    resource: resourceSchema,
    outcome: z.enum(["accepted", "succeeded", "failed", "denied", "unknown"]),
    reason: z
      .enum([
        "invalid_credentials",
        "not_permitted",
        "invalid_request",
        "conflict",
        "provider_unavailable",
        "operation_failed",
        "unverified",
        "bootstrap_required",
      ])
      .optional(),
  })
  .strict();
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditOperation = Pick<AuditRecord, "operationId" | "actor" | "action" | "resource">;
export type AuditActor = AuditRecord["actor"];
export type AuditAction = AuditRecord["action"];

export function auditActor(principal: OrganizerPrincipal): AuditActor {
  if (principal.authMethod === "host-key")
    return { kind: "host-key", role: "Admin", authMethod: "host-key" };
  if (!principal.userId) return { kind: "anonymous" };
  return {
    kind: "organizer",
    userId: principal.userId,
    role: principal.role,
    authMethod: principal.authMethod,
  };
}
