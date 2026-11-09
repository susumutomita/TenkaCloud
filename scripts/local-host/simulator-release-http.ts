import { z } from "zod";
import { consumeSimulatorStream } from "./simulator-release-stream";

const REPOSITORY = "https://github.com/susumutomita/TenkaCloudSimulator";
const RELEASE_API = "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases";
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function simulatorReleaseResponse(
  url: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await fetcher(url, { signal, redirect: "manual", credentials: "omit" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    void response.body?.cancel().catch(() => {
      /* Intentionally ignore cancellation settlement. */
    });
    const location = response.headers.get("location");
    if (!location) throw new Error("Simulator release returned an invalid redirect.");
    const target = new URL(location, url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(target.hostname)
    )
      throw new Error("Simulator release redirected outside the trusted GitHub download hosts.");
    url = target.href;
  }
  throw new Error("Simulator release exceeded the redirect limit.");
}

/** Resolve an exact official asset identity before constructing its anonymous API endpoint. */
export async function officialSimulatorAssetResponse(
  tag: string,
  name: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Response> {
  const url = `${REPOSITORY}/releases/download/${tag}/${name}`;
  const raw = parseMetadata(
    await metadata(`${RELEASE_API}/tags/${tag}`, fetcher, signal, 2 * 1024 * 1024),
  );
  const release = z
    .object({
      tag_name: z.literal(tag),
      draft: z.literal(false),
      prerelease: z.literal(false),
      assets: z.array(
        z.object({
          id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          name: z.string(),
          url: z.string(),
          browser_download_url: z.string(),
          state: z.string(),
        }),
      ),
    })
    .safeParse(raw);
  if (!release.success)
    throw new Error(
      "Simulator release asset API metadata is invalid; the existing lock was retained.",
    );
  const matches = release.data.assets.filter((asset) => asset.name === name);
  const asset = matches[0];
  if (
    matches.length !== 1 ||
    !asset ||
    asset.state !== "uploaded" ||
    asset.browser_download_url !== url ||
    asset.url !== `${RELEASE_API}/assets/${asset.id}`
  )
    throw new Error(
      "Simulator release asset API identity mismatch; the existing lock was retained.",
    );
  // Construct the endpoint from the verified ID, never fetch a supplied URL or attach credentials.
  return simulatorReleaseResponse(
    `${RELEASE_API}/assets/${asset.id}`,
    (target, init) => fetcher(target, { ...init, headers: { Accept: "application/octet-stream" } }),
    signal,
  );
}

export async function metadata(
  url: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  limit: number,
  missingAllowed = false,
  fallback?: () => Promise<Response>,
): Promise<string> {
  let response = await simulatorReleaseResponse(url, fetcher, signal);
  if (fallback && [502, 503, 504].includes(response.status)) {
    // A stalled error-body cancellation must not consume the recovery deadline forever.
    void response.body?.cancel().catch(() => {
      /* The fallback response, not the discarded gateway body, determines the result. */
    });
    signal.throwIfAborted();
    response = await fallback();
    // A missing API asset is a failed recovery, not permission to select an older release.
    missingAllowed = false;
  }
  if (missingAllowed && response.status === 404) {
    void response.body?.cancel().catch(() => {
      /* Intentionally ignore cancellation settlement. */
    });
    return "";
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {
      /* Intentionally ignore cancellation settlement. */
    });
    throw new Error(
      `Simulator release metadata unavailable (HTTP ${response.status}); check connectivity or GitHub rate limits. The existing lock was retained.`,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  await consumeSimulatorStream(response.body, signal, (value) => {
    size += value.byteLength;
    if (size > limit) throw new Error("Simulator release metadata exceeds the size limit.");
    chunks.push(value);
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function parseMetadata(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Simulator release metadata is invalid JSON; no lock was changed.");
  }
}
