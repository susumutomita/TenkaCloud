import type { Context } from "hono";
import { z } from "zod";
import { COMMERCIAL_REGION } from "../../../cloud-hosting/regions.js";
import { CLOUD_EVENT_LIMITS } from "../../control-data/domain/events.js";
import { ApiError } from "./auth.js";

export const identifier = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
/** Adapted from the historical create-event schema; 48 teams allow durable access rows, a replay receipt and the global intake fence. */
export const createEventSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    teams: z
      .array(
        z
          .object({
            internalSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u),
            awsAccountId: z
              .string()
              .regex(/^\d{12}$/u)
              .optional(),
            region: z.string().regex(COMMERCIAL_REGION).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(CLOUD_EVENT_LIMITS.maxTeams),
    problems: z
      .array(
        z
          .object({
            problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
            defaultRegion: z.string().regex(COMMERCIAL_REGION),
            defaultAwsAccountId: z
              .string()
              .regex(/^\d{12}$/u)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(CLOUD_EVENT_LIMITS.maxProblems),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [label, values] of [
      ["internalSlug", value.teams.map((team) => team.internalSlug)],
      ["problemId", value.problems.map((problem) => problem.problemId)],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", message: `Duplicate ${label}` });
    }
  });
export async function body(context: Context): Promise<unknown> {
  const raw = await context.req.text();
  if (new TextEncoder().encode(raw).length > 64 * 1024) throw new ApiError(400, "body_too_large");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, "invalid_body");
  }
}
