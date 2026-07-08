import { describe, expect, it } from "vitest";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import {
  offsetLoopbackEndpoints,
  offsetLoopbackUrl,
  PORT_STRIDE,
  remapComposeHostPorts,
  remapContainerProblem,
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

describe("port-remap: remapContainerProblem (#2392)", () => {
  const portMap = new Map([
    [18080, 18280],
    [18081, 18281],
  ]);
  // A problem whose prose (instructions / hints / i18n) hard-codes the base
  // challenge-surface port, exactly like the catalog's festivalgate problem.
  const problem: ContainerProblem = {
    problemId: "festivalgate-terminal-api",
    name: "Entrance Terminal Trust Boundary",
    description: "Assess http://127.0.0.1:18080/ across four boundaries.",
    instructions: "Run `curl http://127.0.0.1:18080/internal/ops/status`.",
    writeup: "解説: http://127.0.0.1:18080/owner/security を直す。",
    writeupI18n: "Writeup: fix http://127.0.0.1:18080/owner/security.",
    i18n: {
      en: {
        description: "Assess http://127.0.0.1:18080/ across four boundaries.",
        instructions: "Run `curl http://127.0.0.1:18080/internal/ops/status`.",
      },
    },
    problemDir: "/repo/problems/challenges/festivalgate-terminal-api",
    composePath: "/repo/problems/challenges/festivalgate-terminal-api/local/docker-compose.yml",
    composeProjectName: "tc-local-festivalgate-terminal-api",
    challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
    verifyUrl: "http://127.0.0.1:18081/verify",
    secretEnv: ["FLAG_SEED"],
    scoring: {
      kind: "verify",
      points: 100,
      wrongAnswerPenalty: 20,
      hints: [
        {
          id: "h-header",
          content:
            'Try `curl -H "X-Forwarded-For: 10.0.0.9" http://127.0.0.1:18080/internal/ops/status`.',
          penalty: 5,
          i18n: {
            en: { content: "Spoof the first hop at http://127.0.0.1:18080/internal/ops/status." },
          },
        },
      ],
    },
  };

  it("should move every loopback port the problem mentions — endpoints, verify, and prose", () => {
    const moved = remapContainerProblem(problem, portMap);
    expect(moved.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18280/" });
    expect(moved.verifyUrl).toBe("http://127.0.0.1:18281/verify");
    expect(moved.description).toBe("Assess http://127.0.0.1:18280/ across four boundaries.");
    expect(moved.instructions).toBe("Run `curl http://127.0.0.1:18280/internal/ops/status`.");
    expect(moved.writeup).toBe("解説: http://127.0.0.1:18280/owner/security を直す。");
    expect(moved.writeupI18n).toBe("Writeup: fix http://127.0.0.1:18280/owner/security.");
    expect(moved.i18n?.en?.instructions).toBe(
      "Run `curl http://127.0.0.1:18280/internal/ops/status`.",
    );
    // A hint that quotes the surface URL must follow the container too.
    if (moved.scoring.kind !== "verify") throw new Error("expected verify scoring");
    expect(moved.scoring.hints[0].content).toContain("http://127.0.0.1:18280/internal/ops/status");
    expect(moved.scoring.hints[0].i18n?.en?.content).toContain("http://127.0.0.1:18280/");
  });

  it("should leave non-URL fields (paths, ids, points) byte-for-byte", () => {
    const moved = remapContainerProblem(problem, portMap);
    expect(moved.problemDir).toBe(problem.problemDir);
    expect(moved.composePath).toBe(problem.composePath);
    expect(moved.composeProjectName).toBe(problem.composeProjectName);
    expect(moved.secretEnv).toEqual(["FLAG_SEED"]);
    if (moved.scoring.kind !== "verify") throw new Error("expected verify scoring");
    expect(moved.scoring.points).toBe(100);
    expect(moved.scoring.hints[0].penalty).toBe(5);
  });

  it("should be a no-op at the identity port map (offset-0 problem keeps base ports)", () => {
    const identity = new Map([
      [18080, 18080],
      [18081, 18081],
    ]);
    expect(remapContainerProblem(problem, identity)).toEqual(problem);
  });

  it("should pass non-string leaves (null, numbers, booleans) through untouched", () => {
    // The deep string-walk rewrites only string leaves; every other JSON value
    // (including a null, which `typeof` reports as "object") is left as-is.
    const input = { a: null, b: 7, c: true, nested: { url: "http://127.0.0.1:18080/x" } };
    expect(remapContainerProblem(input, portMap)).toEqual({
      a: null,
      b: 7,
      c: true,
      nested: { url: "http://127.0.0.1:18280/x" },
    });
  });
});
