import { z } from "zod";
import { HostError } from "./model";

/**
 * Organizer-supplied binding, independent of endpoints, AWS IDs and secret values.
 * Matching this generation does not attest continuity of the actual DB or token file.
 */
export const simulatorAuthoritySchema = z
  .object({
    authorityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SimulatorAuthority = z.infer<typeof simulatorAuthoritySchema>;

export function authorityBinding(value: unknown): SimulatorAuthority | undefined {
  if (value === undefined) return undefined;
  const parsed = simulatorAuthoritySchema.safeParse(value);
  if (!parsed.success) throw authorityUnavailable();
  return parsed.data;
}

export function sameAuthority(
  left: SimulatorAuthority | undefined,
  right: SimulatorAuthority | undefined,
): boolean {
  return left?.authorityId === right?.authorityId && left?.generation === right?.generation;
}

export function authorityUnavailable(): HostError {
  return new HostError(
    409,
    "The retained Simulator authority is unavailable or does not match its binding. No fallback is permitted.",
    "simulator_authority_unavailable",
  );
}

/** Preserve SDK overloads while checking every operation, including cached credentials. */
export function guardAuthorityClient<T extends object>(client: T, guard: () => void): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key !== "send") return value.bind(target);
      return (...args: unknown[]) => {
        guard();
        return Reflect.apply(value, target, args);
      };
    },
  });
}
