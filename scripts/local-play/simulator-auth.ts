import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { parseLoopbackUrl } from "./loopback";

const TOKEN_PREFIX = "tc_sim_v1";
const MIN_SECRET_BYTES = 32;
const MAX_TTL_SECONDS = 86_400;

export interface SimulatorLaunchNamespace {
  readonly tenantId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly deploymentId: string;
}

function nonEmptyClaim(value: string, field: string): string {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error(`simulator launch token ${field} is invalid`);
  }
  return value;
}

export function createSimulatorLaunchSecret(): string {
  return randomBytes(MIN_SECRET_BYTES).toString("base64url");
}

export function decodeSimulatorLaunchSecret(value: string): Uint8Array {
  let secret: Buffer;
  try {
    secret = Buffer.from(value, "base64url");
  } catch {
    throw new Error("TENKACLOUD_SIMULATOR_LAUNCH_SECRET must be base64url");
  }
  if (secret.byteLength < MIN_SECRET_BYTES || secret.toString("base64url") !== value) {
    throw new Error("TENKACLOUD_SIMULATOR_LAUNCH_SECRET must encode at least 32 bytes");
  }
  return secret;
}

export function issueSimulatorLaunchToken(
  secretValue: string,
  namespace: SimulatorLaunchNamespace,
  ttlSeconds = 3_600,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`simulator launch token TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
  }
  const claims = {
    tenantId: nonEmptyClaim(namespace.tenantId, "tenantId"),
    eventId: nonEmptyClaim(namespace.eventId, "eventId"),
    teamId: nonEmptyClaim(namespace.teamId, "teamId"),
    deploymentId: nonEmptyClaim(namespace.deploymentId, "deploymentId"),
    issuedAt: now,
    expiresAt: now + ttlSeconds * 1_000,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", decodeSimulatorLaunchSecret(secretValue))
    .update(`${TOKEN_PREFIX}.${payload}`)
    .digest("base64url");
  return `${TOKEN_PREFIX}.${payload}.${signature}`;
}

/** Append the token as a fragment so HTTP servers and access logs never receive it. */
export function simulatorConsoleUrl(
  consoleUrl: string,
  launchToken: string,
  simulatorBaseUrl: string,
): string {
  const url = parseLoopbackUrl(consoleUrl, "Simulator console URL");
  const base = parseLoopbackUrl(simulatorBaseUrl, "Simulator base URL");
  if (url.username || url.password || url.origin !== base.origin) {
    throw new Error("Simulator console URL must use the same loopback origin as the launcher");
  }
  url.hash = new URLSearchParams({ token: launchToken }).toString();
  return url.toString();
}
