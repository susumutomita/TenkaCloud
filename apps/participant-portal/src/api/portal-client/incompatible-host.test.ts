import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalValidationError } from "./errors";
import { startProblem } from "./lifecycle";

/**
 * [#3008] A start refused because this machine cannot produce a meaningful result for the
 * problem comes back as 422 with structured fields (which architecture, which CPU flags).
 *
 * Those fields have to survive the client: without them the portal can only print the raw
 * JSON of an unknown error, and the participant has no way to learn that their machine is
 * the reason. So this pins that 422 becomes a `PortalValidationError` carrying the body,
 * not the generic `PortalNetworkError(status, text)` every other non-2xx falls into.
 */

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portalFetch: incompatible host (#3008)", () => {
  it("should surface the refusal code and its structured details", async () => {
    respond(422, {
      error: "incompatible_host",
      code: "unsupported_architecture",
      requiredArchitectures: ["amd64"],
      hostArchitecture: "arm64",
      message: "This problem needs a native amd64 CPU; this machine is arm64.",
      messageJa: "この問題は native な amd64 CPU を必要としますが、 このマシンは arm64 です。",
    });
    const error = await startProblem("http://127.0.0.1:1/", "key", "asm").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalValidationError);
    const validation = error as PortalValidationError;
    expect(validation.errorCode).toBe("incompatible_host");
    expect(validation.details).toMatchObject({
      code: "unsupported_architecture",
      requiredArchitectures: ["amd64"],
      hostArchitecture: "arm64",
    });
  });

  it("should still throw a validation error when the body names no error code", async () => {
    // Fail closed on the client side too: a 422 whose body we cannot read must not fall
    // through to the generic network path and lose the fact that this was a refusal.
    respond(422, {});
    const error = await startProblem("http://127.0.0.1:1/", "key", "asm").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalValidationError);
    expect((error as PortalValidationError).errorCode).toBe("unprocessable");
  });
});
