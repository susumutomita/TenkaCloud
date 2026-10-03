import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ProbeFn, ProbeResult } from "../lib/http-probe-client";

const TIMEOUT_MS = 8_000;

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function publicEndpointUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname.endsWith(".local") ||
    parsed.hostname.endsWith(".internal") ||
    parsed.hostname.startsWith("[") ||
    isIP(parsed.hostname) === 6 ||
    (isIP(parsed.hostname) === 4 && !publicIpv4(parsed.hostname))
  )
    return undefined;
  return parsed;
}

async function pinnedAddress(hostname: string): Promise<string | undefined> {
  if (isIP(hostname) === 4) return publicIpv4(hostname) ? hostname : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: readonly { address: string }[] | undefined;
  try {
    addresses = await Promise.race<readonly { address: string }[] | undefined>([
      lookup(hostname, { all: true, family: 4 }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!addresses || addresses.length === 0 || addresses.some((entry) => !publicIpv4(entry.address)))
    return undefined;
  return addresses[0]?.address;
}

/** Every request connects to the checked IPv4 address. Node's HTTP client never follows redirects. */
export const probePublicEndpoint: ProbeFn = async (value, options = {}): Promise<ProbeResult> => {
  const started = Date.now();
  const failed = (status?: number): ProbeResult => ({
    ok: false,
    status,
    responseTimeMs: Date.now() - started,
  });
  const url = publicEndpointUrl(value);
  if (!url || (options.method && options.method !== "GET")) return failed();
  try {
    const address = await pinnedAddress(url.hostname);
    if (!address) return failed();
    return await new Promise<ProbeResult>((resolve) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          hostname: address,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { host: url.host },
          ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
          agent: false,
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        },
        (response) => {
          const status = response.statusCode;
          response.destroy();
          resolve({
            ok:
              status !== undefined &&
              (options.expectStatus
                ? options.expectStatus.includes(status)
                : status >= 200 && status < 300),
            status,
            responseTimeMs: Date.now() - started,
          });
        },
      );
      request.setTimeout(options.timeoutMs ?? TIMEOUT_MS, () => request.destroy());
      request.once("error", () => resolve(failed()));
      request.end();
    });
  } catch {
    return failed();
  }
};
