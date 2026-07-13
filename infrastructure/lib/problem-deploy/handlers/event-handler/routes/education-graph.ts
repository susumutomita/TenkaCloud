import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  buildEducationGraphResponse,
  type EducationLocale,
  projectEducationMaterials,
} from "../../../../utils/education-graph.js";
import { requireRole, TENANT_ADMIN_ROLE } from "../../deploy-handler/auth.js";
import type { EventSharedResources } from "../shared.js";

export function registerEducationGraphRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/admin/education-graph", (c) => {
    requireRole(c, [TENANT_ADMIN_ROLE]);
    const locale = parseLocale(c);
    if (!locale) return c.json({ error: "invalid_locale" }, StatusCodes.BAD_REQUEST);
    return c.json(
      buildEducationGraphResponse(shared.problemsEducationGraph ?? {}, locale),
      StatusCodes.OK,
    );
  });

  app.get("/admin/education-graph/problems/:problemId/materials", (c) => {
    requireRole(c, [TENANT_ADMIN_ROLE]);
    const locale = parseLocale(c);
    if (!locale) return c.json({ error: "invalid_locale" }, StatusCodes.BAD_REQUEST);
    const problemId = c.req.param("problemId");
    const materials = projectEducationMaterials(
      shared.problemsEducationGraph ?? {},
      problemId,
      locale,
    );
    if (!materials) {
      return c.json({ error: "education_graph_not_found", problemId }, StatusCodes.NOT_FOUND);
    }
    return c.json(materials, StatusCodes.OK);
  });
}

function parseLocale(c: Context): EducationLocale | undefined {
  const locale = c.req.query("locale") ?? "ja";
  return locale === "ja" || locale === "en" ? locale : undefined;
}
