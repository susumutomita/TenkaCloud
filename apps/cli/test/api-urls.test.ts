import { describe, expect, it } from "vitest";
import { apiEnvKey, MissingApiBaseError, resolveApiBase } from "../src/config/api-urls.ts";

describe("resolveApiBase", () => {
  it("should read the env key for each scope", () => {
    const env = {
      TENKACLOUD_API_BASE_CONTROL: "https://control.example.com/",
      TENKACLOUD_API_BASE_TENANT: "https://tenant.example.com",
      TENKACLOUD_API_BASE_DEPLOY: "https://deploy.example.com",
      TENKACLOUD_API_BASE_EVENT: "https://event.example.com",
    };
    expect(resolveApiBase("control", env)).toBe("https://control.example.com");
    expect(resolveApiBase("tenant", env)).toBe("https://tenant.example.com");
    expect(resolveApiBase("deploy", env)).toBe("https://deploy.example.com");
    expect(resolveApiBase("event", env)).toBe("https://event.example.com");
  });
  it("should strip trailing slash", () => {
    expect(resolveApiBase("control", { TENKACLOUD_API_BASE_CONTROL: "https://x/" })).toBe(
      "https://x",
    );
  });
  it("should throw MissingApiBaseError when env unset", () => {
    expect(() => resolveApiBase("control", {})).toThrow(MissingApiBaseError);
  });
  it("should expose the env key name", () => {
    expect(apiEnvKey("control")).toBe("TENKACLOUD_API_BASE_CONTROL");
    expect(apiEnvKey("event")).toBe("TENKACLOUD_API_BASE_EVENT");
  });
});
