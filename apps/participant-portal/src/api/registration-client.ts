import { z } from "zod";

const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
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
    teamLoginKey: secretSchema.optional(),
  })
  .refine((data) => data.state !== "ready" || !!data.teamLoginKey);
export type RegistrationInfo = z.infer<typeof registrationInfoSchema>;
export type RegistrationProgress = z.infer<typeof registrationProgressSchema>;

export async function registrationRequest<T>(
  base: string,
  tenantId: string,
  eventId: string,
  action: "info" | "claim" | "status",
  token: string,
  schema: z.ZodType<T>,
  receipt?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `${base.replace(/\/$/, "")}/portal/registration/${encodeURIComponent(tenantId)}/${encodeURIComponent(eventId)}/${action}`,
    {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(receipt ? { receipt } : {}),
    },
  );
  const data: unknown = await response.json();
  if (!response.ok) {
    const code = z.object({ error: z.string() }).safeParse(data);
    throw new Error(code.success ? code.data.error : "registration_unavailable");
  }
  return schema.parse(data);
}

export function registrationStorage(tenantId: string, eventId: string) {
  const prefix = `tenkacloud.registration.${tenantId}.${eventId}`;
  return {
    invitation(): string | null {
      const incoming = new URLSearchParams(window.location.hash.slice(1)).get("invite");
      if (incoming) {
        if (!secretSchema.safeParse(incoming).success) throw new Error("not_found");
        sessionStorage.setItem(`${prefix}.invite`, incoming);
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      return sessionStorage.getItem(`${prefix}.invite`);
    },
    receipt(): string | null {
      const saved = localStorage.getItem(`${prefix}.receipt`);
      return secretSchema.safeParse(saved).success ? saved : null;
    },
    ensureReceipt(): string {
      const saved = localStorage.getItem(`${prefix}.receipt`);
      if (saved && secretSchema.safeParse(saved).success) return saved;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const receipt = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      localStorage.setItem(`${prefix}.receipt`, receipt);
      return receipt;
    },
  };
}

export async function loadRegistration(
  base: string,
  tenantId: string,
  eventId: string,
  signal: AbortSignal,
) {
  const storage = registrationStorage(tenantId, eventId);
  const invitation = storage.invitation();
  const receipt = storage.receipt();
  if (receipt) {
    try {
      const progress = await registrationRequest(
        base,
        tenantId,
        eventId,
        "status",
        receipt,
        registrationProgressSchema,
        undefined,
        signal,
      );
      return { invitation, progress, info: null };
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "not_found") throw cause;
    }
  }
  if (!invitation) throw new Error("not_found");
  const info = await registrationRequest(
    base,
    tenantId,
    eventId,
    "info",
    invitation,
    registrationInfoSchema,
    undefined,
    signal,
  );
  return { invitation, info, progress: null };
}
