import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireTenantAdmin,
  resolveCognitoSub,
  resolveTenantId,
} from "../deploy-handler/auth.js";
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
import {
  fireDisruption,
  isEventOwnedByTenant,
  listDisruptionAudit,
  listDisruptionCatalog,
} from "./disruption-fire.js";
import { endEvent } from "./end-event.js";
import { getEventDetail, listEvents } from "./list.js";
import { lockScoring, unlockScoring } from "./lock-scoring.js";
import { setEventSchedule } from "./schedule.js";
import { buildEventSharedResources } from "./shared.js";
import {
  BulkDeployRequestSchema,
  CreateEventRequestSchema,
  DisruptionFireRequestSchema,
  ScheduleEventRequestSchema,
} from "./types.js";

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

// #559 defensive layer: handler 内 try/catch を漏れた exception (= 例えば
// `resolveTenantId(c)` の throw、middleware の throw、type 違い等) が API Gateway 層に
// 抜けると 500 + no CORS headers で返ってしまい、browser は「Failed to fetch」とだけ
// 表示して response body を読めない。onError で 500 を Hono response として返せば
// CORS middleware を通って Access-Control-* headers が付き、browser は body の
// `error` field を読めるようになる (= CloudWatch Logs に到達する前に UI で原因が見える)。
//
// `message` は **logs だけ** に残し response body には含めない (= 内部 IAM ARN / table 名 /
// stack trace 等が browser に漏れない、PR-570 review 指摘)。operator は CloudWatch Logs
// の `[events] uncaught handler error` 行で詳細を引く。
app.onError((err, c) => {
  if (err instanceof MissingTenantClaimError) {
    console.warn("[events] missing tenantId claim", { path: c.req.path });
    return c.json(
      { error: "missing_tenant_claim", message: err.message },
      StatusCodes.UNAUTHORIZED,
    );
  }
  // Issue #854: role 不一致は 403、 detail は body に出さず log のみ。
  if (err instanceof ForbiddenRoleError) {
    console.warn("[events] forbidden role", {
      path: c.req.path,
      actualRole: err.actualRole,
      requiredRoles: err.requiredRoles,
    });
    return c.json(
      { error: "forbidden_role", message: "this endpoint requires TenantAdmin role" },
      StatusCodes.FORBIDDEN,
    );
  }
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[events] uncaught handler error", { path: c.req.path, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

// Issue #854: 全 /events/* route で TenantAdmin role を要求 (= 一般 user / monitor bot に
// destructive 操作を許さない、 read 経路でも teamLoginKey が response に含まれるので admin scope)。
// healthz だけ skip。
app.use("/events/*", async (c, next) => {
  if (c.req.path.endsWith("/healthz")) {
    return next();
  }
  requireTenantAdmin(c);
  return next();
});

app.get("/events/healthz", (c) => c.json({ ok: true }));

app.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
  }

  const parsed = CreateEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
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
  if (!parsedLimit) return c.json({ error: "invalid_limit" }, HTTP_BAD_REQUEST);
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
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
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
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
  }
  const parsed = ScheduleEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }
  const nowMs = Date.now();
  // `startNow: true` は server now を ISO8601 化して startsAt に解決 (= 即座に開始)。
  // #536: endsAt も同 endpoint で受け、predictive scheduling を可能に。
  const resolvedStartsAt = parsed.data.startNow
    ? new Date(nowMs).toISOString()
    : parsed.data.startsAt;
  const resolvedEndsAt = parsed.data.endsAt;
  try {
    const outcome = await setEventSchedule(shared, resolveTenantId(c), eventId, {
      startsAt: resolvedStartsAt,
      endsAt: resolvedEndsAt,
      nowMs,
    });
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "past_starts_at") {
      // #537: 過去 startsAt を frontend が迂回した場合の防御線。SLACK (= 60s) より過去なら
      // 「即座に開始」 button を使うべきなので reject。
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
    if (outcome.kind === "past_ends_at") {
      // #536: 過去 endsAt を弾く。「Event を終了」 button (= 即終了) は別 endpoint なので、
      // 本 schedule API には未来の endsAt のみ来る想定。
      return c.json(
        {
          error: "past_ends_at",
          message:
            "endsAt が過去の時刻です。「Event を終了」 button (= 即時) を使うか、未来の時刻を指定してください。",
          endsAt: outcome.endsAt,
          serverNow: new Date(outcome.nowMs).toISOString(),
        },
        HTTP_BAD_REQUEST,
      );
    }
    if (outcome.kind === "ends_before_starts") {
      // #536: 競技時間 0 以下を弾く。
      return c.json(
        {
          error: "ends_before_starts",
          message: "endsAt は startsAt より後の時刻を指定してください。",
          startsAt: outcome.startsAt,
          endsAt: outcome.endsAt,
        },
        HTTP_BAD_REQUEST,
      );
    }
    if (outcome.kind === "no_op") {
      return c.json({ error: "no_op", message: "更新対象が指定されていません" }, HTTP_BAD_REQUEST);
    }
    return c.json(
      {
        startsAt: outcome.startsAt,
        endsAt: outcome.endsAt,
        updatedDeployments: outcome.updatedDeployments,
      },
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
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
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

// #558: scoring lock — operator が表彰フェーズで採点を凍結 / 解除する。
//   - POST  /events/:eventId/lock-scoring : 採点 lock (scoringLocked=true)
//   - DELETE /events/:eventId/lock-scoring : 採点 unlock (scoringLocked を REMOVE)
// idempotent: already locked / unlocked のときは 200 + body に現状を返す。
// status=READY / ENDED のみ lockable (= 加点経路があり得る state)。
app.post("/events/:eventId/lock-scoring", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await lockScoring(
      shared,
      resolveTenantId(c),
      eventId,
      resolveCognitoSub(c),
      Date.now(),
    );
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "not_lockable") {
      return c.json({ error: "not_lockable", currentStatus: outcome.status }, HTTP_CONFLICT);
    }
    return c.json(
      {
        scoringLocked: outcome.scoringLocked,
        scoringLockedAt: outcome.kind === "ok" ? outcome.scoringLockedAt : undefined,
        idempotent: outcome.kind === "already",
      },
      HTTP_OK,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] lockScoring failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.delete("/events/:eventId/lock-scoring", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await unlockScoring(shared, resolveTenantId(c), eventId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "not_lockable") {
      return c.json({ error: "not_lockable", currentStatus: outcome.status }, HTTP_CONFLICT);
    }
    return c.json(
      {
        scoringLocked: outcome.scoringLocked,
        idempotent: outcome.kind === "already",
      },
      HTTP_OK,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] unlockScoring failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/notifications", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
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
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
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
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  // #555: body は opt-in。空 body は bulk-all 扱い (= 後方互換)。値が来た場合だけ
  // validate (= retryFailedOnly / teamIds / problemIds の filter として使う)。
  let body: unknown = {};
  const raw = await c.req.text().catch(() => "");
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
    }
  }
  const parsed = BulkDeployRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await bulkDeployEvent(
      shared,
      resolveTenantId(c),
      eventId,
      Date.now(),
      parsed.data,
    );
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(outcome.result, HTTP_ACCEPTED);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[events] bulkDeployEvent failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

// Issue #888 Phase A: Red Team Disruption Injection
//   GET    /events/:eventId/disruptions          — event 内 disruption catalog
//   GET    /events/:eventId/disruptions/audit    — 発火履歴 (pagination)
//   POST   /events/:eventId/disruptions/fire     — disruption を fire
app.get("/events/:eventId/disruptions", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  try {
    // PR #889 review: 他 tenant の event を obscured ID で覗くのを防ぐため tenant ownership 必須
    if (!(await isEventOwnedByTenant(shared, eventId, resolveTenantId(c)))) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const out = await listDisruptionCatalog(shared, eventId);
    return c.json(out, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[disruptions] catalog failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/events/:eventId/disruptions/audit", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  const limitRaw = c.req.query("limit");
  const parsed = parseLimit(limitRaw);
  if (!parsed) return c.json({ error: "invalid_limit" }, HTTP_BAD_REQUEST);
  const cursor = c.req.query("cursor");
  try {
    // PR #889 review: 他 tenant の audit log を覗かれないよう tenant ownership 必須
    if (!(await isEventOwnedByTenant(shared, eventId, resolveTenantId(c)))) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const out = await listDisruptionAudit(shared, eventId, {
      limit: parsed.limit,
      cursor,
    });
    return c.json(out, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[disruptions] audit list failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/events/:eventId/disruptions/fire", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
  }
  // PR #889 review: 既存 route と整合する Zod parse に統一 (= cross-field 制約も含めて検証)
  const parsed = DisruptionFireRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }
  const req = parsed.data;
  try {
    // PR #889 review: 他 tenant の event に fire できないよう ownership 必須
    if (!(await isEventOwnedByTenant(shared, eventId, resolveTenantId(c)))) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const outcome = await fireDisruption(shared, {
      tenantId: resolveTenantId(c),
      eventId,
      problemId: req.problemId,
      disruptionId: req.disruptionId,
      parameters: req.parameters ?? {},
      scope: req.scope,
      targetTeamIds: req.targetTeamIds ?? [],
      ...(req.randomCount !== undefined ? { randomCount: req.randomCount } : {}),
      requestId: req.requestId,
      firedBy: resolveCognitoSub(c),
      nowMs: Date.now(),
    });
    if (outcome.kind === "ok") return c.json(outcome.result, HTTP_CREATED);
    if (outcome.kind === "duplicate") return c.json(outcome.result, HTTP_OK);
    if (outcome.kind === "unknown_problem")
      return c.json({ error: "unknown_problem" }, HTTP_BAD_REQUEST);
    if (outcome.kind === "unknown_disruption")
      return c.json({ error: "unknown_disruption" }, HTTP_BAD_REQUEST);
    if (outcome.kind === "invalid_parameters")
      return c.json({ error: "invalid_parameters", message: outcome.reason }, HTTP_BAD_REQUEST);
    if (outcome.kind === "invalid_scope")
      return c.json({ error: "invalid_scope", message: outcome.reason }, HTTP_BAD_REQUEST);
    if (outcome.kind === "no_targets") return c.json({ error: "no_targets" }, HTTP_CONFLICT);
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[disruptions] fire failed", { eventId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.delete("/events/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, HTTP_BAD_REQUEST);
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
