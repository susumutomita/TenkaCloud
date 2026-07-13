import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import { corsHeaders, startLocalPlayServer } from "../../../scripts/local-play/server";

const PROBLEM: ContainerProblem = {
  problemId: "origin-guard",
  name: "Origin Guard",
  description: "Exercise the local API origin guard.",
  instructions: "Start the local problem.",
  problemDir: "/catalog/origin-guard",
  composePath: "/catalog/origin-guard/compose.yml",
  composeProjectName: "tc-local-origin-guard",
  challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
  verifyUrl: "http://127.0.0.1:18081/verify",
  secretEnv: [],
  scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
};

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

  it("should reflect the same Codespace participant portal origin", () => {
    expect(
      corsHeaders("https://tenkacloud-demo-5175.app.github.dev", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      }),
    ).toMatchObject({
      "access-control-allow-origin": "https://tenkacloud-demo-5175.app.github.dev",
      vary: "Origin",
    });
  });

  it("should send no CORS headers for a non-loopback origin", () => {
    expect(corsHeaders("https://evil.example.com")).toEqual({});
    expect(corsHeaders("http://127.0.0.1.evil.com")).toEqual({});
    expect(
      corsHeaders("https://other-codespace-5175.app.github.dev", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      }),
    ).toEqual({});
  });

  it("should send no CORS headers when there is no Origin (non-browser client)", () => {
    expect(corsHeaders(undefined)).toEqual({});
  });

  it("should reject a hostile browser origin before a local API side effect", async () => {
    const startContainer = vi.fn(async () => ({
      problem: PROBLEM,
      unit: {
        problemId: PROBLEM.problemId,
        composePath: PROBLEM.composePath,
        composeProjectName: PROBLEM.composeProjectName,
        secretEnv: PROBLEM.secretEnv,
      },
    }));
    const server = await startLocalPlayServer(0, { problems: [PROBLEM] }, { startContainer });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/start`,
        { method: "POST", headers: { origin: "https://attacker.example" } },
      );

      expect(response.status).toBe(StatusCodes.FORBIDDEN);
      expect(await response.json()).toEqual({ error: "browser_origin_forbidden" });
      expect(startContainer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
