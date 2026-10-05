import { z } from "zod";

export const DisruptionFireRequestSchema = z
  .object({
    disruptionId: z.string().min(1).max(64),
    problemId: z.string().min(1).max(128),
    parameters: z.record(z.string(), z.unknown()).optional(),
    scope: z.enum(["all", "team", "random-n"]),
    targetTeamIds: z.array(z.string().min(1).max(128)).max(200).optional(),
    randomCount: z.number().int().finite().min(1).max(200).optional(),
    requestId: z.string().min(8).max(128),
    /**
     * 発火の timing。 `immediate` (既定) は従来どおり即注入、 `scheduled` は
     * operator が `afterMinutes` 分後に注入を予約する (= executor が自分の aws-scheduler で遅延)。
     */
    timing: z.enum(["immediate", "scheduled", "recurring"]).default("immediate"),
    /** scheduled のみ必須。 1〜1440 分 (= 最長 24h)。 finite + integer で NaN / 小数を reject。 */
    afterMinutes: z.number().int().finite().min(1).max(1440).optional(),
    /** recurring のみ必須。 再注入の間隔 (分)。 1〜1440。 */
    intervalMinutes: z.number().int().finite().min(1).max(1440).optional(),
    /** recurring のみ必須。 最大注入回数 (always-ends の上限)。 1〜60。 */
    maxFires: z.number().int().finite().min(1).max(60).optional(),
  })
  .strict()
  .refine((v) => v.timing !== "scheduled" || v.afterMinutes !== undefined, {
    message: "afterMinutes is required when timing is 'scheduled'",
    path: ["afterMinutes"],
  })
  .refine((v) => v.timing === "scheduled" || v.afterMinutes === undefined, {
    message: "afterMinutes is only valid when timing is 'scheduled'",
    path: ["afterMinutes"],
  })
  .refine(
    (v) =>
      v.timing !== "recurring" || (v.intervalMinutes !== undefined && v.maxFires !== undefined),
    {
      message: "intervalMinutes and maxFires are required when timing is 'recurring'",
      path: ["intervalMinutes"],
    },
  )
  .refine(
    (v) =>
      v.timing === "recurring" || (v.intervalMinutes === undefined && v.maxFires === undefined),
    {
      message: "intervalMinutes / maxFires are only valid when timing is 'recurring'",
      path: ["intervalMinutes"],
    },
  )
  .refine((v) => v.scope !== "team" || (v.targetTeamIds && v.targetTeamIds.length > 0), {
    message: "targetTeamIds is required when scope is 'team'",
    path: ["targetTeamIds"],
  })
  .refine((v) => v.scope !== "random-n" || v.randomCount !== undefined, {
    message: "randomCount is required when scope is 'random-n'",
    path: ["randomCount"],
  })
  .refine((v) => v.scope === "team" || !v.targetTeamIds || v.targetTeamIds.length === 0, {
    message: "targetTeamIds is only valid for scope='team'",
    path: ["targetTeamIds"],
  })
  .refine((v) => v.scope === "random-n" || v.randomCount === undefined, {
    message: "randomCount is only valid for scope='random-n'",
    path: ["randomCount"],
  });
export type DisruptionFireRequest = z.infer<typeof DisruptionFireRequestSchema>;
