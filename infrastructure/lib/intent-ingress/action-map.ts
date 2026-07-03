import type { CloudActionIntent } from "@TenkaCloud/trust-bridge";
import {
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
} from "../problem-deploy/handlers/shared/events.js";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ingress: action → frozen detail-type.
 *
 * Only the two mutating deploy actions have a frozen EventBridge detail-type on the
 * existing bus, so the ingress adapter re-emits exactly those:
 *   - `deploy`  → {@link EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED}
 *   - `destroy` → {@link EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED}
 *
 * `inspect` / `collectOutputs` / `verifyTrust` are read/verify verbs with no
 * deploy-bus detail-type; they are rejected loudly as `not-a-deploy-command`
 * rather than silently dropped (AGENTS.md: no silent fallbacks).
 */

export type DeployDetailType =
  | typeof EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED
  | typeof EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED;

export type ActionMapping =
  | { readonly ok: true; readonly detailType: DeployDetailType }
  | { readonly ok: false; readonly reason: "not-a-deploy-command" };

export function mapActionToDetailType(action: CloudActionIntent["action"]["type"]): ActionMapping {
  switch (action) {
    case "deploy":
      return { ok: true, detailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED };
    case "destroy":
      return { ok: true, detailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED };
    default:
      return { ok: false, reason: "not-a-deploy-command" };
  }
}
