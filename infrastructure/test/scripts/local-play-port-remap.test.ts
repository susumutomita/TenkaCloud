import { describe, expect, it } from "vitest";
import {
  offsetLoopbackEndpoints,
  offsetLoopbackUrl,
  PORT_STRIDE,
  portOffsetForIndex,
  remapComposeHostPorts,
} from "../../../scripts/local-play/port-remap";

const COMPOSE = [
  "services:",
  "  app:",
  "    build:",
  "      context: .",
  "    ports:",
  '      - "127.0.0.1:18080:8080" # challenge surface',
  '      - "127.0.0.1:18081:8081" # loopback /verify',
  "    healthcheck:",
  "      test:",
  "        - CMD",
  "        - node",
  "        - -e",
  "        - \"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1))\"",
].join("\n");

describe("port-remap: portOffsetForIndex (#2392)", () => {
  it("should give index 0 a zero offset and space later problems by PORT_STRIDE", () => {
    expect(portOffsetForIndex(0)).toBe(0);
    expect(portOffsetForIndex(1)).toBe(PORT_STRIDE);
    expect(portOffsetForIndex(3)).toBe(3 * PORT_STRIDE);
  });

  it("should reject a negative or non-integer index", () => {
    expect(() => portOffsetForIndex(-1)).toThrow(/non-negative integer/);
    expect(() => portOffsetForIndex(1.5)).toThrow(/non-negative integer/);
  });
});

describe("port-remap: remapComposeHostPorts (#2392)", () => {
  it("should offset only the published host port, never the container or healthcheck port", () => {
    const { text, portMap } = remapComposeHostPorts(COMPOSE, PORT_STRIDE);
    expect(text).toContain('"127.0.0.1:18180:8080"'); // host moved, container 8080 kept
    expect(text).toContain('"127.0.0.1:18181:8081"');
    expect(text).not.toContain("127.0.0.1:18080:"); // old host bindings gone
    // The 2-part healthcheck URL (ip:port) must be untouched.
    expect(text).toContain("http://127.0.0.1:8080/healthz");
    expect(portMap.get(18080)).toBe(18180);
    expect(portMap.get(18081)).toBe(18181);
  });

  it("should be the identity at offset 0 but still record the port map", () => {
    const { text, portMap } = remapComposeHostPorts(COMPOSE, 0);
    expect(text).toBe(COMPOSE);
    expect(portMap.get(18080)).toBe(18080);
    expect(portMap.get(18081)).toBe(18081);
  });

  it("should reject a negative offset and an overflowing host port", () => {
    expect(() => remapComposeHostPorts(COMPOSE, -1)).toThrow(/non-negative integer/);
    expect(() => remapComposeHostPorts(COMPOSE, 60_000)).toThrow(/exceeds 65535/);
  });
});

describe("port-remap: URL / endpoint rewriting (#2392)", () => {
  const portMap = new Map([
    [18080, 18180],
    [18081, 18181],
  ]);

  it("should move a loopback URL's host port and leave unmapped ports alone", () => {
    expect(offsetLoopbackUrl("http://127.0.0.1:18080/", portMap)).toBe("http://127.0.0.1:18180/");
    expect(offsetLoopbackUrl("http://127.0.0.1:18081/verify", portMap)).toBe(
      "http://127.0.0.1:18181/verify",
    );
    // Unmapped port (e.g. an internal port) is untouched.
    expect(offsetLoopbackUrl("http://127.0.0.1:9999/x", portMap)).toBe("http://127.0.0.1:9999/x");
  });

  it("should rewrite every value of an endpoint record", () => {
    expect(
      offsetLoopbackEndpoints(
        { Web: "http://127.0.0.1:18080", Api: "http://127.0.0.1:18081/v" },
        portMap,
      ),
    ).toEqual({ Web: "http://127.0.0.1:18180", Api: "http://127.0.0.1:18181/v" });
  });
});
