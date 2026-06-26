import { z } from "zod";
import { parseLoopbackUrl } from "./loopback";

/**
 * Delegates a participant submission to the problem container's `/verify`
 * endpoint. The platform holds no answer and runs no comparison — it forwards
 * the submission and records the container's verdict (Issue #2054).
 *
 * Hardened against a hostile/buggy container even though it is loopback-only:
 * the URL must be loopback, the call times out, redirects are refused (a
 * container cannot bounce us off-box / SSRF), the response body is size-capped,
 * and the verdict shape is validated before we trust it.
 */

export interface VerifyContext {
  readonly teamId: string;
  readonly problemId: string;
}

export interface VerifyResult {
  readonly correct: boolean;
  /** Optional points override; the harness falls back to the manifest points. */
  readonly points?: number;
  /** Safe, leak-free message the container chose to surface to the player. */
  readonly message?: string;
}

const VerifyResponseSchema = z.object({
  correct: z.boolean(),
  points: z.number().finite().nonnegative().optional(),
  message: z.string().max(2_000).optional(),
});

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export interface VerifyOptions {
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`problem container /verify response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function verifySubmission(
  verifyUrl: string,
  submission: string,
  context: VerifyContext,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const url = parseLoopbackUrl(verifyUrl, "verifyUrl");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ submission, context }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`problem container /verify is unreachable at ${url.origin}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`problem container /verify returned HTTP ${response.status}`);
  }

  const text = await readCappedText(response, MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("problem container /verify returned a non-JSON body", { cause: error });
  }

  const result = VerifyResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `problem container /verify returned an invalid verdict: ${result.error.message}`,
    );
  }
  return result.data;
}
