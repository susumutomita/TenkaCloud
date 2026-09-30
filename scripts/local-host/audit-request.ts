import { randomUUID } from "node:crypto";
import type { AuditAction, AuditOperation, AuditRecord } from "./audit-record";
import { HostError } from "./model";

const ulid = "[0-9A-HJKMNP-TV-Z]{26}";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const fixed: Record<string, AuditAction> = {
  "POST /host/bootstrap": "organizer.bootstrap",
  "POST /host/login": "organizer.login",
  "POST /host/logout": "organizer.logout",
  "POST /host/saml/complete": "organizer.login",
  "PUT /host/saml/provider": "saml.provider_updated",
  "POST /host/saml/identities": "saml.identity_linked",
  "POST /host/users": "organizer.created",
  "PUT /feature-flags": "feature.updated",
  "POST /events": "event.created",
  "POST /admin/competitor-accounts": "competitor_account.registered",
  "POST /admin/competitor-accounts/bulk": "competitor_account.registered",
};
const eventActions: Record<string, AuditAction> = {
  "POST deploy": "event.deploy",
  "DELETE ": "event.teardown",
  "POST end": "event.ended",
  "PATCH schedule": "event.schedule",
  "POST lock-scoring": "event.scoring_lock",
  "DELETE lock-scoring": "event.scoring_lock",
  "POST archive": "event.updated",
  "POST notifications": "event.updated",
  "PUT progression": "progression.updated",
  "DELETE progression": "progression.updated",
  "PUT registration": "registration.updated",
};
function target(
  method: string,
  path: string,
): Pick<AuditOperation, "action" | "resource"> | undefined {
  const action = fixed[`${method} ${path}`];
  if (action) return { action, resource: { kind: "host" } };
  const user = new RegExp(`^/host/users/(${ulid})$`, "u").exec(path);
  if (user?.[1] && (method === "PATCH" || method === "DELETE"))
    return {
      action: method === "PATCH" ? "organizer.updated" : "organizer.deleted",
      resource: { kind: "organizer", id: user[1] },
    };
  const identity = new RegExp(`^/host/saml/identities/(${uuid})$`, "u").exec(path);
  if (identity?.[1] && method === "DELETE")
    return { action: "saml.identity_unlinked", resource: { kind: "identity", id: identity[1] } };
  const account = /^\/admin\/competitor-accounts\/(\d{12})(\/verify)?$/u.exec(path);
  if (account?.[1] && (method === "DELETE" || (method === "POST" && account[2])))
    return {
      action: method === "DELETE" ? "competitor_account.deleted" : "competitor_account.verified",
      resource: { kind: "account", id: account[1] },
    };
  return eventTarget(method, path);
}
function eventTarget(
  method: string,
  path: string,
): Pick<AuditOperation, "action" | "resource"> | undefined {
  const event = new RegExp(`^/events/(${ulid})(?:/(.*))?$`, "u").exec(path);
  if (!event?.[1]) return undefined;
  const suffix = event[2] ?? "";
  const action = eventActions[`${method} ${suffix}`];
  if (action) return { action, resource: { kind: "event", id: event[1] } };
  const team = new RegExp(`^teams/(${ulid})/rotate-login-key$`, "u").exec(suffix);
  if (team?.[1] && method === "POST")
    return { action: "team.credential_rotated", resource: { kind: "team", id: team[1] } };
  const job = new RegExp(`^deployments/(${ulid})(?:/(stop|restart))?$`, "u").exec(suffix);
  if (!job?.[1]) return undefined;
  if (method === "DELETE" && !job[2])
    return { action: "environment.teardown", resource: { kind: "job", id: job[1] } };
  if (method === "POST" && job[2])
    return {
      action: job[2] === "stop" ? "environment.stop" : "environment.restart",
      resource: { kind: "job", id: job[1] },
    };
  return undefined;
}

// Only recognized routes and validated identifiers enter the record, never a URL/body/token.
export function auditRequest(method: string, path: string): AuditOperation | undefined {
  const intent = target(method, path);
  return intent
    ? { ...intent, operationId: randomUUID(), actor: { kind: "anonymous" } }
    : undefined;
}
export function auditFailure(error: unknown): Pick<AuditRecord, "outcome" | "reason"> {
  if (!(error instanceof HostError)) return { outcome: "failed", reason: "operation_failed" };
  if (error.status === 401) return { outcome: "denied", reason: "invalid_credentials" };
  if (error.status === 403) return { outcome: "denied", reason: "not_permitted" };
  if (error.status === 409) return { outcome: "failed", reason: "conflict" };
  if (error.status < 500) return { outcome: "failed", reason: "invalid_request" };
  return { outcome: "failed", reason: "provider_unavailable" };
}
