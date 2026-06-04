/**
 * Hono route wiring for the IdP CRUD API. Shared between Control Plane
 * (#1293) and Application Plane (#1294) — each plane builds its own
 * {@link RouteWiringOptions} (different scope resolver, different role).
 */

import { IdpIdSchema } from "@tenkacloud/saml-utils";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { secureApiHeaders } from "../../../problem-deploy/handlers/shared/secure-headers.js";
import { resolveCognitoSub } from "./auth.js";
import {
  type AuditEventInput,
  createIdp,
  deleteIdp,
  emitAudit,
  getIdp,
  type IdpHandlerDeps,
  type IdpHandlerError,
  type IdpScope,
  listIdps,
  updateIdp,
} from "./core.js";

export interface RouteWiringOptions {
  /**
   * Pulls the IdP scope from the request. Control Plane returns
   * `{ kind: "system" }` after authorizing the caller as SystemAdmin.
   * Application Plane returns `{ kind: "tenant", tenantId }` from the JWT
   * after authorizing the caller as TenantAdmin scoped to that tenant.
   *
   * Returns a `Response` to short-circuit when authorization fails (= 403).
   */
  readonly resolveScope: (c: Context) => IdpScope | { readonly forbidden: Response };
  /** Public path prefix (e.g. `/admin/idp` or `/tenant/idp`). */
  readonly pathPrefix: string;
  /** Handler deps (store + cognito adapter + clock). */
  readonly deps: IdpHandlerDeps;
}

export function buildIdpApp(opts: RouteWiringOptions): Hono {
  const app = new Hono();

  // #1694: API セキュリティヘッダを CORS より前 (outermost) に適用 (= onError 経路にも付与)。
  app.use("*", secureApiHeaders());

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[idp-handler] uncaught", { path: c.req.path, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  });

  app.get(`${opts.pathPrefix}/healthz`, (c) => c.json({ ok: true }, StatusCodes.OK));

  // GET list ------------------------------------------------------------
  app.get(opts.pathPrefix, async (c) => {
    const scope = opts.resolveScope(c);
    if ("forbidden" in scope) return scope.forbidden;
    const actor = resolveCognitoSub(c);
    const items = await listIdps(opts.deps, scope);
    audit({ action: "idp.read", scope, actorSub: actor, outcome: "success" });
    // Strip metadataXml from list responses — admins fetch full body on detail
    // view only. Keeps list response small + avoids accidental leak in logs.
    return c.json({ items: items.map(({ metadataXml: _xml, ...rest }) => rest) }, StatusCodes.OK);
  });

  // GET one --------------------------------------------------------------
  app.get(`${opts.pathPrefix}/:idpId`, async (c) => {
    const scope = opts.resolveScope(c);
    if ("forbidden" in scope) return scope.forbidden;
    const idpId = c.req.param("idpId");
    if (!IdpIdSchema.safeParse(idpId).success) {
      return c.json({ error: "invalid_idp_id" }, StatusCodes.BAD_REQUEST);
    }
    const actor = resolveCognitoSub(c);
    const result = await getIdp(opts.deps, scope, idpId);
    if ("error" in result) {
      audit({
        action: "idp.read",
        scope,
        actorSub: actor,
        idpId,
        outcome: "not_found",
      });
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    audit({ action: "idp.read", scope, actorSub: actor, idpId, outcome: "success" });
    return c.json(result, StatusCodes.OK);
  });

  // POST create ----------------------------------------------------------
  app.post(opts.pathPrefix, async (c) => {
    const scope = opts.resolveScope(c);
    if ("forbidden" in scope) return scope.forbidden;
    const actor = resolveCognitoSub(c);
    const body = await safeJson(c);
    const result = await createIdp(opts.deps, scope, body);
    if ("error" in result) {
      return mapError(c, result.error, "idp.create", scope, actor);
    }
    audit({
      action: "idp.create",
      scope,
      actorSub: actor,
      idpId: result.idpId,
      outcome: "success",
    });
    return c.json(result, StatusCodes.CREATED);
  });

  // PATCH update ---------------------------------------------------------
  app.patch(`${opts.pathPrefix}/:idpId`, async (c) => {
    const scope = opts.resolveScope(c);
    if ("forbidden" in scope) return scope.forbidden;
    const idpId = c.req.param("idpId");
    if (!IdpIdSchema.safeParse(idpId).success) {
      return c.json({ error: "invalid_idp_id" }, StatusCodes.BAD_REQUEST);
    }
    const actor = resolveCognitoSub(c);
    const body = await safeJson(c);
    const result = await updateIdp(opts.deps, scope, idpId, body);
    if ("error" in result) {
      return mapError(c, result.error, "idp.update", scope, actor, idpId);
    }
    audit({ action: "idp.update", scope, actorSub: actor, idpId, outcome: "success" });
    return c.json(result, StatusCodes.OK);
  });

  // DELETE ---------------------------------------------------------------
  app.delete(`${opts.pathPrefix}/:idpId`, async (c) => {
    const scope = opts.resolveScope(c);
    if ("forbidden" in scope) return scope.forbidden;
    const idpId = c.req.param("idpId");
    if (!IdpIdSchema.safeParse(idpId).success) {
      return c.json({ error: "invalid_idp_id" }, StatusCodes.BAD_REQUEST);
    }
    const actor = resolveCognitoSub(c);
    const result = await deleteIdp(opts.deps, scope, idpId);
    if (typeof result === "object" && "error" in result) {
      return mapError(c, result.error, "idp.delete", scope, actor, idpId);
    }
    audit({ action: "idp.delete", scope, actorSub: actor, idpId, outcome: "success" });
    return c.body(null, StatusCodes.NO_CONTENT);
  });

  return app;
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function audit(input: AuditEventInput): void {
  emitAudit(input);
}

function mapError(
  c: Context,
  err: IdpHandlerError,
  action: AuditEventInput["action"],
  scope: IdpScope,
  actorSub: string,
  idpId?: string,
): Response {
  switch (err.kind) {
    case "validation":
      audit({
        action,
        scope,
        actorSub,
        idpId,
        outcome: "error",
        errorMessage: err.message,
      });
      return c.json({ error: "validation_failed", detail: err.message }, StatusCodes.BAD_REQUEST);
    case "invalid_metadata":
      audit({
        action,
        scope,
        actorSub,
        idpId,
        outcome: "error",
        errorMessage: err.reason,
      });
      return c.json({ error: "invalid_metadata", reason: err.reason }, StatusCodes.BAD_REQUEST);
    case "not_found":
      audit({ action, scope, actorSub, idpId, outcome: "not_found" });
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    case "conflict":
      audit({
        action,
        scope,
        actorSub,
        idpId,
        outcome: "conflict",
        errorMessage: err.message,
      });
      return c.json({ error: "conflict" }, StatusCodes.CONFLICT);
    case "internal":
      audit({
        action,
        scope,
        actorSub,
        idpId,
        outcome: "error",
        errorMessage: err.message,
      });
      return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
}
