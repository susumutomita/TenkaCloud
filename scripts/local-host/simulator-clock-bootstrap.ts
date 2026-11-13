import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";

const sampleSchema = z.strictObject({
  version: z.literal(2),
  domain: z.string(),
  nonce: z.string(),
  ticksMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  validUntilMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mac: z.string().regex(/^[a-f0-9]{64}$/u),
});
export interface SimulatorSignedResponse {
  readonly nonce: string;
  readonly path: string;
  readonly request: Uint8Array;
  readonly status: number;
  readonly body: Uint8Array;
  readonly domain: string;
  readonly mac: string;
}
export interface OwnedSimulatorClock {
  readonly domain: string;
  authenticateResponse(response: SimulatorSignedResponse): void;
  /** Authenticates one challenged sample, not a shared clock or runtime availability. */
  authenticateSample(value: unknown, nonce: string): { ticksMs: number; validUntilMs: number };
}
function decodeBootstrap(bytes: Buffer): OwnedSimulatorClock {
  // Exact Go JSON encoder envelope rejects duplicate fields, extra objects and secret reflection.
  const match =
    /^\{"version":2,"domain":"(mono-[a-f0-9]{32})","key":"([a-f0-9]{64})","clock":"linux-clock-monotonic"\}\n$/u.exec(
      bytes.toString("utf8"),
    );
  if (!match || match[0].length !== bytes.length)
    throw new Error("Invalid private Simulator clock bootstrap.");
  const domain = match[1] as string;
  const key = Buffer.from(match[2] as string, "hex");
  return Object.freeze({
    domain,
    authenticateResponse(r: SimulatorSignedResponse) {
      if (
        r.domain !== domain ||
        !/^[a-f0-9]{64}$/u.test(r.nonce) ||
        !/^[a-f0-9]{64}$/u.test(r.mac) ||
        !/^\/_simulator\/v1\/battle-capabilities\/[a-z0-9/-]+$/u.test(r.path) ||
        r.request.length > 8192 ||
        r.body.length > 65536 ||
        !Number.isInteger(r.status) ||
        r.status < 100 ||
        r.status > 599
      )
        throw new Error("Invalid signed Simulator response.");
      const requestHash = createHash("sha256").update(r.request).digest("hex");
      const mac = createHmac("sha256", key)
        .update(
          `TCS-RESPONSE-3\n${domain}\n${r.nonce}\nPOST\n${r.path}\n${requestHash}\n${r.status}\n${r.body.length}\n`,
        )
        .update(r.body)
        .digest();
      if (!timingSafeEqual(mac, Buffer.from(r.mac, "hex")))
        throw new Error("Unauthenticated Simulator response.");
    },
    authenticateSample(value: unknown, nonce: string) {
      const parsed = sampleSchema.safeParse(value);
      if (!/^[a-f0-9]{64}$/u.test(nonce) || !parsed.success)
        throw new Error("Invalid Simulator clock sample.");
      const s = parsed.data;
      if (s.domain !== domain || s.nonce !== nonce || s.validUntilMs - s.ticksMs !== 30_000)
        throw new Error("Unbound Simulator clock sample.");
      const expected = createHmac("sha256", key)
        .update(`TCS-CLOCK-2\n${domain}\n${nonce}\n${s.ticksMs}\n${s.validUntilMs}\n`)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(s.mac, "hex")))
        throw new Error("Unauthenticated Simulator clock sample.");
      return { ticksMs: s.ticksMs, validUntilMs: s.validUntilMs };
    },
  });
}
/** Only the newly spawned, pinned child's anonymous FD3 may be supplied. Never HTTP/stdout/files. */
export function receiveOwnedSimulatorClock(
  pipe: Readable,
  signal?: AbortSignal,
  timeoutMs = 5000,
): Promise<OwnedSimulatorClock> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pipe.removeListener("data", data);
      pipe.removeListener("end", end);
      pipe.removeListener("close", close);
      // Keep the error listener through destroy; do not expose pipe diagnostics or key bytes.
      pipe.destroy();
      try {
        if (error) reject(error);
        else resolve(decodeBootstrap(bytes));
      } catch {
        reject(new Error("Invalid private Simulator clock bootstrap."));
      } finally {
        bytes.fill(0);
      }
    };
    const abort = () => finish(new Error("Simulator clock bootstrap cancelled."));
    const data = (chunk: Buffer) => {
      if (bytes.length + chunk.length > 512)
        return finish(new Error("Simulator clock bootstrap exceeds bound."));
      bytes = Buffer.concat([bytes, chunk]);
    };
    const end = () => finish();
    const close = () => finish(new Error("Simulator clock bootstrap closed before EOF."));
    const timer = setTimeout(
      () => finish(new Error("Simulator clock bootstrap timed out.")),
      timeoutMs,
    );
    pipe.on("data", data);
    pipe.once("end", end);
    pipe.once("close", close);
    pipe.on("error", () => finish(new Error("Simulator clock bootstrap transport failed.")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
