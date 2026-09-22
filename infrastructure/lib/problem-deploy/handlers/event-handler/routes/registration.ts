import type { Hono } from "hono";
import { z } from "zod";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
  TENANT_ROLES,
} from "../../deploy-handler/auth.js";
import { ULID_RE } from "../../shared/constants.js";
import {
  configureRegistration,
  RegistrationError,
  registrationSummary,
} from "../../shared/event-registration.js";
import { auditEventAction } from "../audit.js";
import { handleRouteError, withEventId, withJsonBody } from "../route-helpers.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveEventRepositories,
} from "../shared.js";

const configSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      closesAt: z.string().datetime(),
      teamIds: z.array(z.string().regex(ULID_RE)).min(1).max(99),
    })
    .strict(),
]);

export function registerRegistrationAdminRoutes(app: Hono, shared: EventSharedResources) {
  app.get(
    "/events/:eventId/registration",
    withEventId(
      async ({ c, eventId }) => {
        const repositories = await resolveEventRepositories(shared);
        const event = await repositories.events.getEvent(resolveTenantId(c), eventId);
        if (!event) return c.json({ error: "not_found" }, 404);
        return c.json(registrationSummary(event));
      },
      { roles: TENANT_ROLES },
    ),
  );
  app.put(
    "/events/:eventId/registration",
    withJsonBody(
      configSchema,
      async ({ c, body }) => {
        const parsed = z.string().regex(ULID_RE).safeParse(c.req.param("eventId"));
        if (!parsed.success) return c.json({ error: "invalid_event_id" }, 400);
        const eventId = parsed.data;
        try {
          const repositories = await resolveEventRepositories(shared);
          const result = await configureRegistration(
            { ...repositories, deployments: await resolveDeploymentsRepository(shared) },
            resolveTenantId(c),
            eventId,
            body,
          );
          auditEventAction(c, body.enabled ? "open_registration" : "close_registration", eventId);
          return c.json(result);
        } catch (error) {
          if (error instanceof RegistrationError)
            return c.json({ error: error.code }, error.code === "not_found" ? 404 : 409);
          return handleRouteError(c, "[registration] configuration failed", { eventId }, error);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE], rejectSuspendedTenant: true },
    ),
  );
}
