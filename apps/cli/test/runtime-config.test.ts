import { describe, expect, it } from "vitest";
import { generateLocalRuntimeConfig } from "../src/local/runtime-config.ts";

describe("generateLocalRuntimeConfig", () => {
  it("should use the default eventTitle when none is provided", () => {
    const json = generateLocalRuntimeConfig({ apiBaseUrl: "http://127.0.0.1:8080" });
    expect(JSON.parse(json).eventTitle).toBe("TenkaCloud Local (self-paced)");
  });

  it("should use the provided eventTitle when given", () => {
    const json = generateLocalRuntimeConfig({
      apiBaseUrl: "http://127.0.0.1:8080",
      eventTitle: "My Custom Event",
    });
    expect(JSON.parse(json).eventTitle).toBe("My Custom Event");
  });

  it("should emit the exact local-mode config shape", () => {
    const json = generateLocalRuntimeConfig({ apiBaseUrl: "http://127.0.0.1:9000" });
    expect(JSON.parse(json)).toEqual({
      apiBaseUrl: "http://127.0.0.1:9000",
      eventTitle: "TenkaCloud Local (self-paced)",
      eventRegion: "local",
      mode: "backend",
      cloudMode: "mock",
    });
  });

  it("should pretty-print with two-space indentation and a trailing newline", () => {
    const json = generateLocalRuntimeConfig({ apiBaseUrl: "http://127.0.0.1:1234" });
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('\n  "apiBaseUrl": "http://127.0.0.1:1234"');
    // The exact serialization matches JSON.stringify(..., null, 2) + "\n".
    expect(json).toBe(
      `${JSON.stringify(
        {
          apiBaseUrl: "http://127.0.0.1:1234",
          eventTitle: "TenkaCloud Local (self-paced)",
          eventRegion: "local",
          mode: "backend",
          cloudMode: "mock",
        },
        null,
        2,
      )}\n`,
    );
  });
});
