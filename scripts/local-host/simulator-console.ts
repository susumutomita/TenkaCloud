import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import { z } from "zod";
import { HostError } from "./model";
import type { SimulatorConsoleIssuer } from "./participant-aws-contract";

const capabilitySchema = z.object({
  consoleHandoff: z.object({ version: z.literal(1), services: z.array(z.string()) }).optional(),
  // An unknown or malformed advertisement counts as none: problems that need it stay hidden.
  nativeSdk: z
    .object({
      version: z.literal(1),
      services: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/u)).max(32),
    })
    .optional()
    .catch(undefined),
});

export interface SimulatorCapabilities {
  /** Present only when the Simulator issues participant Console handoffs. */
  readonly console?: SimulatorConsoleIssuer;
  /** Signing services its native SDK sessions accept; empty on Simulators that do not say. */
  readonly nativeSdkServices: readonly string[];
}
const handoffSchema = z.object({
  Code: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  ExpiresAt: z.iso.datetime({ offset: true }),
});

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Simulator returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error("Simulator response exceeded its size limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

/** Only the native authority receives a participant's signed short-lived credentials. */
export async function connectSimulatorCapabilities(
  endpoint: string,
  operatorToken: string,
  guard: () => void,
  httpFetch: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<SimulatorCapabilities> {
  const origin = normalizeSimulatorEndpointUrl(endpoint);
  guard();
  let capabilities: z.infer<typeof capabilitySchema>;
  try {
    const response = await httpFetch(`${origin}/_simulator/v1/capabilities`, {
      headers: { "X-Simulator-Token": operatorToken },
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error("Simulator capability request failed.");
    capabilities = capabilitySchema.parse(await boundedJson(response, 256 * 1024));
  } catch {
    throw new Error(
      "Could not verify Simulator Console capabilities. Check the local Simulator connection.",
    );
  }
  const nativeSdkServices = capabilities.nativeSdk?.services ?? [];
  if (!capabilities.consoleHandoff?.services.includes("ssm-parameter"))
    return { nativeSdkServices };
  const issue: SimulatorConsoleIssuer = async (
    { credentials, parameterName, region },
    assertCurrent,
  ) => {
    assertCurrent();
    guard();
    if (
      !/^\/[A-Za-z0-9_.\-/]{1,1010}$/u.test(parameterName) ||
      !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u.test(region) ||
      credentials.expiration.getTime() <= Date.now()
    )
      throw new HostError(409, "This Simulator Console target is not ready.", "not_ready");
    try {
      const url = new URL("/_simulator/v1/console-handoffs", origin);
      const body = JSON.stringify({ ParameterName: parameterName, Region: region });
      const signer = new SignatureV4({
        credentials,
        region,
        service: "sts",
        sha256: Sha256,
      });
      const signed = await signer.sign({
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        headers: { host: url.host, "content-type": "application/json" },
        body,
      });
      assertCurrent();
      guard();
      const response = await httpFetch(url.href, {
        method: "POST",
        headers: signed.headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error("Simulator handoff request failed.");
      const handoff = handoffSchema.parse(await boundedJson(response, 4096));
      const expiry = Date.parse(handoff.ExpiresAt);
      if (expiry <= Date.now() || expiry > Date.now() + 120_000)
        throw new Error("Simulator returned an invalid handoff lifetime.");
      assertCurrent();
      const login = new URL("/_simulator/login", origin);
      login.hash = new URLSearchParams({ handoff: handoff.Code }).toString();
      return login.href;
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError(
        502,
        "Simulator Console sign-in could not be issued. Retry while the environment is running.",
        "simulator_console_failed",
      );
    }
  };
  return { console: issue, nativeSdkServices };
}
