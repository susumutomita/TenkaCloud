import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("should not turn a persistence exception message into a public request error", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("invalid_json"))
      .mockResolvedValue(undefined);
    const server = await startLocalPlayServer(
      0,
      { problems: [PROBLEM], participantToken: "a".repeat(43) },
      {
        startContainer: async () => ({
          problem: PROBLEM,
          unit: {
            problemId: PROBLEM.problemId,
            composePath: PROBLEM.composePath,
            composeProjectName: PROBLEM.composeProjectName,
            secretEnv: PROBLEM.secretEnv,
          },
        }),
        stateStore: {
          description: "injected failure",
          load: async () => undefined,
          save,
          clear: async () => {},
          close: async () => {},
        },
      },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/start`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${"a".repeat(43)}` },
        },
      );

      expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      expect(await response.json()).toEqual({ error: "internal" });
    } finally {
      await server.close();
      await server.closeStateStore();
    }
  });

  it("should reflect a loopback origin (the portal dev server)", () => {
    expect(corsHeaders("http://localhost:5175")).toMatchObject({
      "access-control-allow-origin": "http://localhost:5175",
      vary: "Origin",
    });
    expect(corsHeaders("http://127.0.0.1:5175")["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:5175",
    );
    expect(corsHeaders("http://[::1]:5175")["access-control-allow-origin"]).toBe(
      "http://[::1]:5175",
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

  it("should send no CORS headers for a non-portal origin", () => {
    expect(corsHeaders("https://evil.example.com")).toEqual({});
    expect(corsHeaders("http://127.0.0.1.evil.com")).toEqual({});
    expect(corsHeaders("http://127.0.0.1:8080")).toEqual({});
    expect(corsHeaders("http://localhost:4173")).toEqual({});
    expect(
      corsHeaders("https://other-codespace-5175.app.github.dev", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      }),
    ).toEqual({});
    expect(
      corsHeaders("https://tenkacloud-demo-5175.attacker.example", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev@attacker.example",
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

  it("should allow the exact Codespaces portal Origin but reject API self-Origin mutations", async () => {
    vi.stubEnv("CODESPACE_NAME", "tenkacloud-demo");
    vi.stubEnv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev");
    const startContainer = vi.fn(async () => ({
      problem: PROBLEM,
      unit: {
        problemId: PROBLEM.problemId,
        composePath: PROBLEM.composePath,
        composeProjectName: PROBLEM.composeProjectName,
        secretEnv: PROBLEM.secretEnv,
      },
    }));
    const server = await startLocalPlayServer(
      0,
      { problems: [PROBLEM], participantToken: "a".repeat(43) },
      { startContainer },
    );
    const endpoint = `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/start`;
    try {
      const selfOrigin = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      expect(selfOrigin.status).toBe(StatusCodes.FORBIDDEN);
      expect(startContainer).not.toHaveBeenCalled();

      const portalOrigin = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          origin: "https://tenkacloud-demo-5175.app.github.dev",
        },
      });
      // Container start は 202 (async) — CORS 判定の関心はここでは「通ったか」のみ。
      expect(portalOrigin.status).toBe(StatusCodes.ACCEPTED);
      expect(startContainer).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it("should forward participant authorization to the console handoff route", async () => {
    const server = await startLocalPlayServer(0, { problems: [PROBLEM] });
    const endpoint = `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/console-handoff`;
    try {
      const unauthenticated = await fetch(endpoint, { method: "POST" });
      expect(unauthenticated.status).toBe(StatusCodes.UNAUTHORIZED);

      const authenticated = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${server.state.participantToken}` },
      });
      expect(authenticated.status).toBe(StatusCodes.NOT_FOUND);
      expect(await authenticated.json()).toEqual({ error: "unknown_simulated_problem" });
    } finally {
      await server.close();
    }
  });

  it("should reject missing or stale session tokens on every participant route", async () => {
    const server = await startLocalPlayServer(0, {
      problems: [PROBLEM],
      participantToken: "a".repeat(43),
    });
    const endpoint = `http://127.0.0.1:${server.port}/portal/me`;
    try {
      const missing = await fetch(endpoint);
      expect(missing.status).toBe(StatusCodes.UNAUTHORIZED);
      const stale = await fetch(endpoint, {
        headers: { authorization: `Bearer ${"b".repeat(43)}` },
      });
      expect(stale.status).toBe(StatusCodes.UNAUTHORIZED);
      const current = await fetch(endpoint, {
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      });
      expect(current.status).toBe(StatusCodes.OK);
    } finally {
      await server.close();
    }
  });

  it("should require CLI bearer auth and reject browser origins on operator routes", async () => {
    const server = await startLocalPlayServer(0, {
      problems: [PROBLEM],
      participantToken: "a".repeat(43),
    });
    const endpoint = `http://127.0.0.1:${server.port}/local/operator/problems/unknown/disruptions/test/fire`;
    try {
      const missing = await fetch(endpoint, { method: "POST" });
      expect(missing.status).toBe(StatusCodes.UNAUTHORIZED);

      const browser = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          origin: "http://127.0.0.1:5175",
        },
      });
      expect(browser.status).toBe(StatusCodes.FORBIDDEN);
      expect(await browser.json()).toEqual({ error: "operator_browser_forbidden" });

      const cli = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      });
      expect(cli.status).toBe(StatusCodes.NOT_FOUND);
      expect(await cli.json()).toEqual({ error: "unknown_disruption" });
    } finally {
      await server.close();
    }
  });

  /**
   * [#2906 audit finding] Cross-port dev serving meant a browser request always carried
   * an Origin header, so the Origin check alone defended every operator route regardless
   * of method. Same-origin container serving removes that guarantee (a same-origin GET
   * navigation may omit Origin), so the Bearer-token requirement below — unconditional
   * for every method, not just POST — is what must hold on its own. Pin it explicitly so
   * a future operator GET route can't ship without carrying the same check.
   */
  it("should reject an unauthenticated GET with no Origin on an operator route (#2906 same-origin audit)", async () => {
    const server = await startLocalPlayServer(0, {
      problems: [PROBLEM],
      participantToken: "a".repeat(43),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/local/operator/problems/unknown/disruptions/test/fire`,
        { method: "GET" },
      );
      expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    } finally {
      await server.close();
    }
  });

  /**
   * [#2906 audit finding, round 2] Before this fix, the CORS allowlist's direct-origin
   * check was hardcoded to port 5175 regardless of what the server actually bound —
   * harmless on the host/dev path (the Portal there is Vite, always on its own fixed
   * port, independent of the API's own port), but wrong once Portal and API share one
   * port in container mode: a `LOCAL_API_PORT` override would silently reject every
   * same-origin POST from the Portal. `server.port` here is an OS-assigned port that
   * (with overwhelming likelihood) is not 5175, so this pins that the allowlist now
   * tracks the container's actual bound port instead of the old fixed literal.
   */
  it("should allow a same-origin POST whose Origin matches the container's own non-default bound port", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "tenkacloud-portal-dist-cors-"));
    writeFileSync(join(distDir, "index.html"), "<!doctype html>");
    const startContainer = vi.fn(async () => ({
      problem: PROBLEM,
      unit: {
        problemId: PROBLEM.problemId,
        composePath: PROBLEM.composePath,
        composeProjectName: PROBLEM.composeProjectName,
        secretEnv: PROBLEM.secretEnv,
      },
    }));
    const server = await startLocalPlayServer(
      0,
      { problems: [PROBLEM], participantToken: "a".repeat(43) },
      { startContainer, portalDistDir: distDir },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/start`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${"a".repeat(43)}`,
            origin: `http://127.0.0.1:${server.port}`,
          },
        },
      );
      expect(response.status).toBe(StatusCodes.ACCEPTED);
      expect(startContainer).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});
