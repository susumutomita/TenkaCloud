import { StatusCodes } from "http-status-codes";
import { isSsrfSafeUrl } from "./ssrf-guard.js";

export interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly responseTimeMs: number;
  readonly body?: string;
}

export interface ProbeOptions {
  readonly expectStatus?: readonly number[];
  readonly timeoutMs?: number;
  readonly readBody?: boolean;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}

export type ProbeFn = (url: string, options?: ProbeOptions) => Promise<ProbeResult>;

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 4_096;

/**
 * Runtime HTTP adapter for scoring probes.
 *
 * The scoring kernel depends on the `ProbeFn` boundary and may inject another implementation. This
 * concrete adapter owns outbound HTTP, timeout policy, redirect revalidation, and bounded body reads.
 */
export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  if (!isSsrfSafeUrl(url)) {
    clearTimeout(timer);
    return { ok: false, status: undefined, responseTimeMs: Date.now() - startedAt };
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
      ...(options.method === "POST" && options.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: options.body }
        : {}),
    });
    const responseTimeMs = Date.now() - startedAt;
    const finalUrl = response.url;
    const safeFinal = !finalUrl || isSsrfSafeUrl(finalUrl);
    const ok =
      safeFinal &&
      (options.expectStatus
        ? options.expectStatus.includes(response.status)
        : response.status >= StatusCodes.OK && response.status < StatusCodes.MULTIPLE_CHOICES);
    const body =
      options.readBody && ok ? await readCappedBody(response, MAX_BODY_BYTES) : undefined;
    return {
      ok,
      status: response.status,
      responseTimeMs,
      ...(body !== undefined ? { body } : {}),
    };
  } catch {
    return { ok: false, status: undefined, responseTimeMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function readCappedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  try {
    const stream = response.body;
    if (stream && typeof stream.getReader === "function") {
      const bytes = await drainStreamCapped(stream.getReader(), maxBytes);
      return new TextDecoder().decode(bytes);
    }
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return undefined;
  }
}

async function drainStreamCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.length > maxBytes ? merged.subarray(0, maxBytes) : merged;
}
