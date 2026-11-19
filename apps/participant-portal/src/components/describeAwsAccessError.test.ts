import { describe, expect, it } from "vitest";
import { PortalNetworkError, PortalValidationError } from "../api/portal-client";
import { describeAccessError } from "./describeAwsAccessError";

const t = (key: string) => key;

describe("describeAccessError", () => {
  it("turns a not-ready refusal into a next step instead of the API's JSON", () => {
    const err = new PortalNetworkError(409, '{"error":"guest_not_ready","message":"internal"}');
    expect(describeAccessError(err, t)).toBe("sso_credentials.error_not_ready");
    expect(describeAccessError(new PortalValidationError("not_ready"), t)).toBe(
      "sso_credentials.error_not_ready",
    );
  });

  it("explains a Simulator that cannot do the operation", () => {
    expect(
      describeAccessError(new PortalNetworkError(409, '{"error":"console_unavailable"}'), t),
    ).toBe("sso_credentials.error_unsupported");
  });

  it("never shows an unknown or unreadable API body", () => {
    expect(describeAccessError(new PortalNetworkError(500, "<html>oops</html>"), t)).toBe(
      "sso_credentials.error_generic",
    );
    expect(describeAccessError(new PortalNetworkError(502, '{"error":5}'), t)).toBe(
      "sso_credentials.error_generic",
    );
    expect(describeAccessError(new PortalNetworkError(409, "null"), t)).toBe(
      "sso_credentials.error_generic",
    );
  });

  it("keeps a readable local message", () => {
    expect(describeAccessError(new Error("Endpoint is unusable."), t)).toBe(
      "Endpoint is unusable.",
    );
  });
});
