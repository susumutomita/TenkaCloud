import { z } from "zod";

export const registrationSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const RegistrationConfigSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      closesAt: z.string().datetime(),
      teamIds: z
        .array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/))
        .min(1)
        .max(99),
    })
    .strict(),
]);
export type RegistrationConfigInput = z.infer<typeof RegistrationConfigSchema>;

export const registrationInfoSchema = z.object({
  name: z.string(),
  state: z.enum(["open", "closed", "full"]),
  remaining: z.number().int().nonnegative(),
});
export const registrationProgressSchema = z
  .object({
    eventName: z.string(),
    teamId: z.string(),
    state: z.enum(["unprepared", "preparing", "failed", "ready"]),
    ready: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    teamLoginKey: registrationSecretSchema.optional(),
  })
  .refine((data) => data.state !== "ready" || !!data.teamLoginKey);
export type RegistrationInfo = z.infer<typeof registrationInfoSchema>;
export type RegistrationProgress = z.infer<typeof registrationProgressSchema>;

interface RegistrationEventWindow {
  readonly status: string;
  readonly expiresAt: number;
  readonly endsAt?: string;
}

/** Admission and receipt delivery stop when event access itself ends. */
export function registrationEventActive<T extends RegistrationEventWindow>(
  event: T | undefined,
  now: number,
): event is T {
  return (
    !!event &&
    ["DRAFT", "DEPLOYING", "READY"].includes(event.status) &&
    event.expiresAt > Math.floor(now / 1000) &&
    (!event.endsAt || Date.parse(event.endsAt) > now)
  );
}

/** Pool shape and deadline only. Runtime readiness/account policy belong to each adapter. */
export function validRegistrationSelection(
  event: RegistrationEventWindow,
  teamIds: readonly string[],
  closesAt: string,
  now: number,
): boolean {
  const closes = Date.parse(closesAt);
  return (
    teamIds.length > 0 &&
    teamIds.length <= 99 &&
    new Set(teamIds).size === teamIds.length &&
    Number.isFinite(closes) &&
    closes > now &&
    closes <= event.expiresAt * 1000 &&
    (!event.endsAt || closes <= Date.parse(event.endsAt))
  );
}
