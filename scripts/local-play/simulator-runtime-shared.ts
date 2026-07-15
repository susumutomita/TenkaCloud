import { createHmac } from "node:crypto";
import type { SimulatorDeploymentResponse } from "./simulator";
import type { SimulatorLauncherRecord } from "./simulator-launcher";

export const START_TIMEOUT_MS = 15_000;
export const DEPLOY_TIMEOUT_MS = 30_000;
export const RETRY_DELAY_MS = 100;
export const TOKEN_TTL_SECONDS = 86_400;
export const TOKEN_RENEW_WINDOW_MS = 60 * 60 * 1_000;

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function deploymentError(deployment: SimulatorDeploymentResponse): Error {
  const diagnostic = deployment.diagnostics?.map((item) => item.message).join("; ");
  return new Error(
    diagnostic
      ? `Simulator deployment ${deployment.status}: ${diagnostic}`
      : `Simulator deployment entered ${deployment.status}`,
  );
}

export function safeMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, unknown>>;
}

export function internalProviderIdempotencyKey(
  launcher: SimulatorLauncherRecord,
  domain: "attack-probe" | "endpoint-placement",
  parts: readonly string[],
): string {
  const digest = createHmac("sha256", launcher.launchSecret)
    .update(JSON.stringify({ domain, parts }))
    .digest("base64url");
  return `tenkacloud-internal-${domain}-${digest}`;
}

export function positiveDuration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return duration;
}
