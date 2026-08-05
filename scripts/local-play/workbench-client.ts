import { z } from "zod";
import { readCappedResponseText } from "./bounded-response";
import { parseLoopbackUrl } from "./loopback";

/**
 * Bounded, loopback-only client for the editor contract hosted by a running
 * problem container. The Participant Portal never talks to these ports directly:
 * the authenticated local API calls this client and returns only validated JSON.
 */

export type WorkbenchAction = "config" | "starter" | "inspect" | "test" | "prepare";

export type WorkbenchFn = (
  verifyUrl: string,
  action: WorkbenchAction,
  body?: unknown,
) => Promise<unknown>;

const CheckpointSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  kind: z.enum(["code", "answer"]),
});

const ConfigSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: z.string().max(5_000),
  submittedFiles: z.array(z.string().min(1).max(240)).min(1).max(16),
  checkpoints: z.array(CheckpointSchema).min(1).max(32),
});

const StarterSchema = z.record(z.string(), z.string());
const InspectSchema = z.union([
  z.object({ output: z.string().max(1_000_000) }),
  z.record(z.string(), z.unknown()).transform((value) => ({
    output: JSON.stringify(value, null, 2),
  })),
]);
const TestSchema = z.object({
  passed: z.boolean(),
  output: z.string().max(1_000_000),
});
const PrepareSchema = z.union([
  z.object({
    ok: z.literal(true),
    submissions: z.record(z.string(), z.string()),
  }),
  z.object({
    ok: z.literal(false),
    output: z.string().max(20_000),
    missingManual: z.array(z.string().max(200)).max(32).optional(),
  }),
]);

const SCHEMAS = {
  config: ConfigSchema,
  starter: StarterSchema,
  inspect: InspectSchema,
  test: TestSchema,
  prepare: PrepareSchema,
} as const;

const GET_ACTIONS = new Set<WorkbenchAction>(["config", "starter", "inspect"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export class WorkbenchClientError extends Error {
  constructor(
    readonly code: "not_supported" | "unavailable" | "invalid_response",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkbenchClientError";
  }
}

export async function requestWorkbench(
  verifyUrl: string,
  action: WorkbenchAction,
  body?: unknown,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const verify = parseLoopbackUrl(verifyUrl, "verifyUrl");
  const url = new URL(`/api/${action}`, verify.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: GET_ACTIONS.has(action) ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    throw new WorkbenchClientError(
      "unavailable",
      `problem container editor is unreachable at ${url.origin}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new WorkbenchClientError("not_supported", "problem container has no editor contract");
  }
  if (!response.ok) {
    throw new WorkbenchClientError(
      "unavailable",
      `problem container editor returned HTTP ${response.status}`,
    );
  }

  const text = await readCappedResponseText(
    response,
    MAX_RESPONSE_BYTES,
    () =>
      new WorkbenchClientError(
        "invalid_response",
        `problem container editor response exceeds ${MAX_RESPONSE_BYTES} bytes`,
      ),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WorkbenchClientError(
      "invalid_response",
      "problem container editor returned non-JSON",
      {
        cause: error,
      },
    );
  }
  const result = SCHEMAS[action].safeParse(parsed);
  if (!result.success) {
    throw new WorkbenchClientError(
      "invalid_response",
      `problem container editor returned an invalid ${action} payload`,
      { cause: result.error },
    );
  }
  return result.data;
}
