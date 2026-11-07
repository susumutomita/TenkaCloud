/* eslint-disable sonarjs/no-clear-text-protocols -- These fixtures verify the explicit loopback HTTP simulator contract. */
import { describe, expect, it } from "vitest";
import { normalizeSimulatorEndpointUrl } from "../src/index";

describe("simulator credential endpoint", () => {
  it("accepts only canonical numeric loopback HTTP origins", () => {
    expect(normalizeSimulatorEndpointUrl("http://127.0.0.1:4566/")).toBe("http://127.0.0.1:4566");
    expect(normalizeSimulatorEndpointUrl("http://[::1]:4566")).toBe("http://[::1]:4566");
  });
  it("normalizes default ports and leading zero ports idempotently", () => {
    for (const host of ["127.0.0.1", "[::1]"]) {
      for (const port of ["80", "00080", "004566"]) {
        const normalized = normalizeSimulatorEndpointUrl(`http://${host}:${port}/`);
        expect(normalized).toBe(`http://${host}:${Number(port)}`);
        expect(normalizeSimulatorEndpointUrl(normalized)).toBe(normalized);
      }
    }
  });
  it("rejects remote destinations, ambiguous hosts, injection and decorated URLs", () => {
    for (const value of [
      "http://localhost:4566",
      "http://127.1:4566",
      "http://2130706433:4566",
      "https://127.0.0.1:4566",
      "http://example.com:4566",
      "http://169.254.169.254:80",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1",
      "http://user:secret@127.0.0.1:4566",
      "http://127.0.0.1:4566/path",
      "http://127.0.0.1:4566/?query=1",
      "http://127.0.0.1:4566/#fragment",
      "http://127.0.0.1:4566';echo BAD",
      "http://127.0.0.1:4566\n",
    ])
      expect(() => normalizeSimulatorEndpointUrl(value)).toThrow("numeric loopback");
  });
});
