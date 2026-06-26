import { describe, expect, it } from "vitest";
import { corsHeaders } from "../../../scripts/local-play/server";

describe("local-play CORS", () => {
  it("should reflect a loopback origin (the portal dev server)", () => {
    expect(corsHeaders("http://localhost:5175")).toMatchObject({
      "access-control-allow-origin": "http://localhost:5175",
      vary: "Origin",
    });
    expect(corsHeaders("http://127.0.0.1:5175")["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:5175",
    );
  });

  it("should send no CORS headers for a non-loopback origin", () => {
    expect(corsHeaders("https://evil.example.com")).toEqual({});
    expect(corsHeaders("http://127.0.0.1.evil.com")).toEqual({});
  });

  it("should send no CORS headers when there is no Origin (non-browser client)", () => {
    expect(corsHeaders(undefined)).toEqual({});
  });
});
