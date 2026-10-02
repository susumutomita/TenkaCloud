import type { Hono } from "hono";
import { z } from "zod";
import type { CloudDeploymentWork } from "../../control-data/cloud-data-ports.js";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import { ApiError, type OrganizerAuthConfig, requireOrganizer } from "./auth.js";
import {
  type CloudCoordinationApi,
  nativeProblem,
  settleNativeEvent,
} from "./coordination-routes.js";
import { body, identifier } from "./schema.js";

interface ScheduleInput {
  readonly startNow?: boolean;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly scoreboardFreezeMinutes?: number;
}
function validatedSchedule(
  input: ScheduleInput,
  event: { readonly startsAt?: string; readonly endsAt?: string },
  now: number,
) {
  if ((input.startNow && input.startsAt) || Object.keys(input).length === 0)
    throw new ApiError(400, "invalid_schedule");
  const startsAt = input.startNow
    ? new Date(now).toISOString()
    : (input.startsAt ?? event.startsAt);
  const endsAt = input.endsAt ?? event.endsAt;
  if (input.startsAt && Date.parse(input.startsAt) < now - 60_000)
    throw new ApiError(400, "past_starts_at");
  if (input.endsAt && Date.parse(input.endsAt) <= now) throw new ApiError(400, "past_ends_at");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    throw new ApiError(400, "ends_before_starts");
  return { startsAt, endsAt };
}
/** Reuses the historical startNow/schedule wire contract; automatic deploy/teardown scheduling is absent. */
export function registerCloudScheduleRoutes(
  app: Hono,
  options: {
    readonly repository: CloudRepository;
    readonly work: CloudDeploymentWork;
    readonly coordination?: CloudCoordinationApi;
    readonly organizerAuth: OrganizerAuthConfig;
    readonly now: () => number;
  },
): void {
  app.patch("/events/:eventId/schedule", async (context) => {
    const now = options.now();
    requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, now);
    const event = await options.repository.getEvent(identifier.parse(context.req.param("eventId")));
    if (!event) throw new ApiError(404, "not_found");
    const input = z
      .object({
        startNow: z.boolean().optional(),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
        scoreboardFreezeMinutes: z.number().int().min(0).max(180).optional(),
      })
      .strict()
      .parse(await body(context));
    const { startsAt, endsAt } = validatedSchedule(input, event, now);
    const updatedAt = new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString();
    const patch = { startsAt, endsAt, scoreboardFreezeMinutes: input.scoreboardFreezeMinutes };
    const native = options.coordination
      ? await settleNativeEvent(options.coordination, event, options.now, patch)
      : undefined;
    if (!native) await options.work.setSchedule(event, patch, updatedAt);
    return context.json({
      startsAt,
      endsAt,
      scoreboardFreezeMinutes: input.scoreboardFreezeMinutes ?? event.scoreboardFreezeMinutes,
      updatedDeployments: 0,
    });
  });
  app.post("/events/:eventId/end", async (context) => {
    const now = options.now();
    requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, now);
    const event = await options.repository.getEvent(identifier.parse(context.req.param("eventId")));
    if (!event) throw new ApiError(404, "not_found");
    if (event.status === "TEARDOWN" || event.status === "ARCHIVED")
      throw new ApiError(409, "event_closed");
    const patch = {
      status: "ENDED" as const,
      endsAt: new Date(now).toISOString(),
      scoringLocked: true,
    };
    let updated: EventRecord | undefined;
    if (nativeProblem(event)) {
      updated = options.coordination
        ? await settleNativeEvent(options.coordination, event, options.now, patch, true)
        : undefined;
      if (!updated) throw new ApiError(409, "coordination_not_initialized");
    } else {
      await options.work.setSchedule(
        event,
        patch,
        new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString(),
      );
      updated = { ...event, ...patch };
    }
    return context.json({
      eventId: event.eventId,
      status: updated.status,
      endsAt: updated.endsAt,
      updatedDeployments: 0,
    });
  });
  for (const method of ["post", "delete"] as const)
    app[method]("/events/:eventId/lock-scoring", async (context) => {
      const now = options.now();
      requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, now);
      const event = await options.repository.getEvent(
        identifier.parse(context.req.param("eventId")),
      );
      if (!event) throw new ApiError(404, "not_found");
      const scoringLocked = method === "post";
      const native = options.coordination
        ? await settleNativeEvent(options.coordination, event, options.now, { scoringLocked })
        : undefined;
      if (!native)
        await options.work.setSchedule(
          event,
          { scoringLocked },
          new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString(),
        );
      return context.json({ eventId: event.eventId, scoringLocked });
    });
}
