import { randomBytes } from "node:crypto";
import { z } from "zod";
import { directWebTransport } from "./direct-web-transport";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";
import { readSimulatorToken } from "./simulator-token";

const availability = z.strictObject({
  configured: z.boolean(),
  protocolVersion: z.literal(2),
  clockDomain: z.string(),
});
export type BattleCapabilityOperation =
  | "availability"
  | "resolve"
  | "seal"
  | "clock"
  | `${string}/${"frontend" | "api"}/${"start" | "read"}`;
/** Authenticated provider request. Resolve associates an owned deployment; never retry implicitly. */
export async function requestBattleCapability(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  operation: BattleCapabilityOperation,
  input: unknown,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  if (
    !/^(?:availability|resolve|seal|clock|[a-f0-9]{64}\/(?:frontend|api)\/(?:start|read))$/u.test(
      operation,
    )
  )
    throw new Error("Invalid Battle capability operation.");
  const target = new URL(settings.endpoint);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("Owned numeric loopback Simulator required.");
  const path = `/_simulator/v1/battle-capabilities/${operation}`;
  target.pathname = path;
  const token =
    "readToken" in settings ? settings.readToken() : readSimulatorToken(settings.tokenFile);
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token))
    throw new Error("Invalid Simulator operator credential.");
  const nonce = randomBytes(32).toString("hex");
  const request = new TextEncoder().encode(JSON.stringify(input));
  if (request.length > 8192) throw new Error("Simulator request exceeds bound.");
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const response = await (dependencies.transport ?? directWebTransport)(target, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "X-Simulator-Token": token,
      "X-Simulator-Clock-Nonce": nonce,
      "Content-Type": "application/json",
    },
    body: request.buffer as ArrayBuffer,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const elapsed = now() - started;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 5000)
    throw new Error("Simulator capability response expired.");
  clock.authenticateResponse({
    nonce,
    path,
    request,
    status: response.status,
    body,
    domain: response.headers.get("X-Simulator-Clock-Domain") ?? "",
    mac: response.headers.get("X-Simulator-Clock-MAC") ?? "",
  });
  if (!response.ok) throw new Error("Simulator capability unavailable.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}
export async function inspectBattleCapability(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  const result = availability.parse(
    await requestBattleCapability(settings, clock, "availability", { version: 1 }, dependencies),
  );
  if (result.clockDomain !== clock.domain || !result.configured)
    throw new Error("Simulator Battle runtime is not configured.");
  return {
    kind: "authenticated-battle-availability" as const,
    configured: true as const,
    scoringQualified: false as const,
    battleAcceptancePassed: false as const,
  };
}
