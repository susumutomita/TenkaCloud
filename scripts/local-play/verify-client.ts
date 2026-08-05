import { z } from "zod";
import { readCappedResponseText } from "./bounded-response";
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
  /** [#2252] echo of the judged checkpoint (required when the request sent one). */
  checkpointId: z.string().max(200).optional(),
});

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export interface VerifyOptions {
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * [#2252] multi-verify: which checkpoint this submission targets. Sent as a
   * top-level `checkpointId` field; the container MUST echo it back and the
   * echo is enforced here (a mismatched or missing echo fails the submission
   * loudly — never mis-attribute a verdict to another checkpoint).
   */
  readonly checkpointId?: string;
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
      body: JSON.stringify({
        ...(options.checkpointId !== undefined ? { checkpointId: options.checkpointId } : {}),
        submission,
        context,
      }),
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

  const text = await readCappedResponseText(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`problem container /verify response exceeds ${MAX_RESPONSE_BYTES} bytes`),
  );
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
  // [#2252] fail-closed checkpoint correlation: when we asked about a specific
  // checkpoint, the verdict must name that same checkpoint. Anything else risks
  // crediting the wrong checkpoint, so it is an error, not a wrong answer.
  if (options.checkpointId !== undefined && result.data.checkpointId !== options.checkpointId) {
    throw new Error(
      `problem container /verify did not echo checkpointId "${options.checkpointId}" (got ${JSON.stringify(result.data.checkpointId)})`,
    );
  }
  return result.data;
}
