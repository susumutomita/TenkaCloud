import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { endEvent } from "../end-event.js";
import { handleRouteError, parseJsonBody, withEventId } from "../route-helpers.js";
import { type SetEventScheduleOutcome, setEventSchedule } from "../schedule.js";
import type { EventSharedResources } from "../shared.js";
import { ScheduleEventRequestSchema } from "../types.js";

/**
 * Translate a `setEventSchedule` outcome into an HTTP response. Extracted from
 * the route handler so each branch stays small and biome's cognitive-complexity
 * budget is satisfied without losing the original error semantics.
 */
function scheduleOutcomeResponse(c: Context, outcome: SetEventScheduleOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    case "past_starts_at":
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
        StatusCodes.BAD_REQUEST,
      );
    case "past_ends_at":
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
        StatusCodes.BAD_REQUEST,
      );
    case "ends_before_starts":
      // #536: 競技時間 0 以下を弾く。
      return c.json(
        {
          error: "ends_before_starts",
          message: "endsAt は startsAt より後の時刻を指定してください。",
          startsAt: outcome.startsAt,
          endsAt: outcome.endsAt,
        },
        StatusCodes.BAD_REQUEST,
      );
    case "past_teardown_at":
      // 過去 teardownAt を弾く (即時撤去は別の Delete Event 経路を使う)。
      return c.json(
        {
          error: "past_teardown_at",
          message:
            "teardownAt が過去の時刻です。未来の時刻を指定するか、即時撤去は「Event を削除」を使ってください。",
          teardownAt: outcome.teardownAt,
          serverNow: new Date(outcome.nowMs).toISOString(),
        },
        StatusCodes.BAD_REQUEST,
      );
    case "teardown_before_ends":
      // always-ends: 採点 gate (endsAt) を閉じる前に撤去しない。
      return c.json(
        {
          error: "teardown_before_ends",
          message: "teardownAt は endsAt 以降の時刻を指定してください。",
          teardownAt: outcome.teardownAt,
          endsAt: outcome.endsAt,
        },
        StatusCodes.BAD_REQUEST,
      );
    case "past_deploy_at":
      // 過去 deployAt を弾く (即時 deploy は別の「Deploy」button を使う)。
      return c.json(
        {
          error: "past_deploy_at",
          message:
            "deployAt が過去の時刻です。未来の時刻を指定するか、即時 deploy は「Deploy」を使ってください。",
          deployAt: outcome.deployAt,
          serverNow: new Date(outcome.nowMs).toISOString(),
        },
        StatusCodes.BAD_REQUEST,
      );
    case "deploy_after_ends":
      // deploy → 採点 → 終了 の時系列を保つ (deploy は終了より後ろに置けない)。
      return c.json(
        {
          error: "deploy_after_ends",
          message: "deployAt は endsAt 以前の時刻を指定してください。",
          deployAt: outcome.deployAt,
          endsAt: outcome.endsAt,
        },
        StatusCodes.BAD_REQUEST,
      );
    case "no_op":
      return c.json(
        { error: "no_op", message: "更新対象が指定されていません" },
        StatusCodes.BAD_REQUEST,
      );
    case "ok":
      return c.json(
        {
          startsAt: outcome.startsAt,
          endsAt: outcome.endsAt,
          teardownAt: outcome.teardownAt,
          deployAt: outcome.deployAt,
          updatedDeployments: outcome.updatedDeployments,
        },
        StatusCodes.OK,
      );
  }
}

/**
 * Event lifecycle (schedule / end) routes.
 *
 *   PATCH /events/:eventId/schedule
 *   POST  /events/:eventId/end
 */
export function registerLifecycleRoutes(app: Hono, shared: EventSharedResources): void {
  app.patch(
    "/events/:eventId/schedule",
    withEventId(
      async ({ c, eventId }) => {
        const parsed = await parseJsonBody(c, ScheduleEventRequestSchema);
        if (!parsed.ok) return parsed.response;
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
            teardownAt: parsed.data.teardownAt,
            deployAt: parsed.data.deployAt,
            scoreboardFreezeMinutes: parsed.data.scoreboardFreezeMinutes,
            nowMs,
          });
          if (outcome.kind === "ok") auditEventAction(c, "schedule_event", eventId);
          return scheduleOutcomeResponse(c, outcome);
        } catch (err) {
          return handleRouteError(c, "[events] setEventSchedule failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );

  app.post(
    "/events/:eventId/end",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await endEvent(shared, resolveTenantId(c), eventId, Date.now());
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          if (outcome.kind === "not_endable") {
            return c.json(
              { error: "not_endable", currentStatus: outcome.status },
              StatusCodes.CONFLICT,
            );
          }
          auditEventAction(c, "end_event", eventId);
          return c.json(
            { endsAt: outcome.endsAt, updatedDeployments: outcome.updatedDeployments },
            StatusCodes.OK,
          );
        } catch (err) {
          return handleRouteError(c, "[events] endEvent failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
