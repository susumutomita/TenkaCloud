import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { resolveCognitoSub, resolveTenantId } from "../deploy-handler/auth.js";
import { ULID_RE as EVENT_ID_RE } from "../shared/constants.js";
import {
  HTTP_ACCEPTED,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_CREATED,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
} from "../shared/http-status.js";
import { NotificationCreateRequestSchema } from "../shared/notification.js";
import { archiveEvent } from "./archive.js";
import { bulkTeardownEvent } from "./bulk-delete.js";
import { bulkDeployEvent } from "./bulk-deploy.js";
import { createEvent, DuplicateInternalSlugError, DuplicateProblemIdError } from "./create.js";
import { createNotification } from "./create-notification.js";
import { endEvent } from "./end-event.js";
import { getEventDetail, listEvents } from "./list.js";
import { setEventSchedule } from "./schedule.js";
import { buildEventSharedResources } from "./shared.js";
import { CreateEventRequestSchema, ScheduleEventRequestSchema } from "./types.js";

/**
 * Event API Lambda の Hono app (ADR-004 Phase 1+2a, ADR-006 Notifications)。routes:
 *   POST   /events
 *   GET    /events
 *   GET    /events/:eventId
 *   POST   /events/:eventId/deploy         — Bulk deploy (teams × problems を fan-out)
 *   POST   /events/:eventId/notifications  — 運営 → 競技者 通知 1 件作成 (ADR-006)
 *   DELETE /events/:eventId                — Bulk teardown
 *
 * Auth: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim
 * から `resolveTenantId` で抽出する (DeployApi Lambda と同じ shape)。
 */

const LIST_LIMIT_MAX = 200;

const shared = buildEventSharedResources();

function parseLimit(value: string | undefined): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/events/healthz", (c) => c.json({ ok: true }));

app.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, HTTP_BAD_REQUEST);
  }

  const parsed = CreateEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }

  try {
    const response = await createEvent(
      shared,
      { tenantId: resolveTenantId(c), nowMs: Date.now() },
      parsed.data,
    );
    return c.json(response, HTTP_CREATED);
  } catch (err) {
    if (err instanceof DuplicateInternalSlugError) {
      return c.json({ error: "duplicate_internal_slug", slug: err.slug }, HTTP_BAD_REQUEST);
    }
    if (err instanceof DuplicateProblemIdError) {
      return c.json({ error: "duplicate_problem_id", problemId: err.problemId }, HTTP_BAD_REQUEST);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] createEvent failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/events", async (c) => {
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid limit" }, HTTP_BAD_REQUEST);
  try {
    const response = await listEvents(shared, {
      tenantId: resolveTenantId(c),
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] listEvents failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/events/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  try {
    const detail = await getEventDetail(shared, resolveTenantId(c), eventId);
    if (!detail) return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(detail, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] getEventDetail failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.patch("/events/:eventId/schedule", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, HTTP_BAD_REQUEST);
  }
  const parsed = ScheduleEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }
  const nowMs = Date.now();
  // `startNow: true` は server now を ISO8601 化して採用 (= 即座に開始ボタンの裏挙動)。
  const startsAt = "startNow" in parsed.data ? new Date(nowMs).toISOString() : parsed.data.startsAt;
  try {
    const outcome = await setEventSchedule(shared, resolveTenantId(c), eventId, startsAt, nowMs);
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "past_starts_at") {
      // #537: 過去日時を frontend が迂回した場合の防御線。SLACK_MS (= 60s) より過去なら
      // 「即座に開始」 button を使うべきなので reject。message は frontend で表示する。
      return c.json(
        {
          error: "past_starts_at",
          message:
            "startsAt が過去の時刻です。「即座に開始」 button を使うか、未来の時刻を指定してください。",
          startsAt: outcome.startsAt,
          serverNow: new Date(outcome.nowMs).toISOString(),
        },
        HTTP_BAD_REQUEST,
      );
    }
    return c.json(
      { startsAt: outcome.startsAt, updatedDeployments: outcome.updatedDeployments },
      HTTP_OK,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] setEventSchedule failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/end", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await endEvent(shared, resolveTenantId(c), eventId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "not_endable") {
      return c.json({ error: "not_endable", currentStatus: outcome.status }, HTTP_CONFLICT);
    }
    return c.json(
      { endsAt: outcome.endsAt, updatedDeployments: outcome.updatedDeployments },
      HTTP_OK,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] endEvent failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/notifications", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, HTTP_BAD_REQUEST);
  }
  const parsed = NotificationCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await createNotification(
      shared,
      resolveTenantId(c),
      eventId,
      resolveCognitoSub(c),
      parsed.data,
    );
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(
      { notificationId: outcome.notificationId, occurredAt: outcome.occurredAt },
      HTTP_CREATED,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] createNotification failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/archive", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await archiveEvent(shared, resolveTenantId(c), eventId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "not_archivable") {
      return c.json({ error: "not_archivable", currentStatus: outcome.status }, HTTP_CONFLICT);
    }
    return c.json({ archivedAt: outcome.archivedAt }, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] archiveEvent failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/deploy", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await bulkDeployEvent(shared, resolveTenantId(c), eventId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(outcome.result, HTTP_ACCEPTED);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] bulkDeployEvent failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.delete("/events/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid eventId" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await bulkTeardownEvent(shared, resolveTenantId(c), eventId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(outcome.result, HTTP_ACCEPTED);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] bulkTeardownEvent failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
