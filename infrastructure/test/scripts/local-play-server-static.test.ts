import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalPlayServer } from "../../../scripts/local-play/server";

/**
 * `fetch()` derives (and refuses to let a caller override) the `Host` header
 * from the connection target — exactly the opposite of what a real forwarding
 * proxy does (connects to 127.0.0.1, forwards the ORIGINAL Host it received).
 * A raw `http.request` is the only way to actually simulate that from a test.
 */
function fetchWithHost(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * [#2906] The containerized entrypoint serves the prebuilt Participant Portal and a
 * dynamic runtime-config.json from the SAME server/port as the API — no host Vite
 * process, no file write. `portalDistDir` is what turns this on; every other test in
 * this suite starts the server without it and must see the untouched host/dev
 * behavior (a bare 404 from the API router, not a static-file fallback).
 */

const dirsToClean: string[] = [];

function makePortalDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-portal-dist-"));
  dirsToClean.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Participant Portal</title>");
  writeFileSync(join(dir, "app.js"), "console.log('portal');");
  return dir;
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("local-play static portal serving", () => {
  it("serves a real static asset with its content type", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/app.js`);
      expect(response.status).toBe(StatusCodes.OK);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(await response.text()).toBe("console.log('portal');");
    } finally {
      await server.close();
    }
  });

  it("falls back to index.html for an unknown path (SPA deep link)", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/problems/hello-world`);
      expect(response.status).toBe(StatusCodes.OK);
      expect(await response.text()).toContain("Participant Portal");
    } finally {
      await server.close();
    }
  });

  it("never lets a static path escape the portal dist directory", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/${encodeURIComponent("../../../etc/passwd")}`,
      );
      // The escape attempt is rejected before any file read, so the request falls through
      // to the ordinary API router's 404 — never index.html, never a file outside distDir.
      expect(response.status).toBe(StatusCodes.NOT_FOUND);
      expect(await response.json()).toEqual({ error: "not_found" });
    } finally {
      await server.close();
    }
  });

  it("serves a dynamic runtime-config.json built from the bound port, not a file", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime-config.json`);
      expect(response.status).toBe(StatusCodes.OK);
      const config = await response.json();
      expect(config.apiBaseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(config.localTeamLoginKey).toBe("a".repeat(43));
    } finally {
      await server.close();
    }
  });

  /**
   * [#2906 audit finding] The old two-port host/dev model needed a Codespaces-
   * specific `/__tenkacloud-local-api` proxy-prefix rewrite to reach a
   * *different* port than the Portal's. Same-origin container serving has no
   * second port to reach, so runtime-config.json must instead echo back
   * whatever origin the request itself arrived on — this is what makes a
   * forwarded origin (Codespaces, or any reverse proxy) work with zero
   * Codespaces-specific code in the container path.
   */
  it("derives apiBaseUrl from the request's own forwarded origin, not a fixed host:port", async () => {
    vi.stubEnv("CODESPACE_NAME", "improbable-space-orb-abc123");
    vi.stubEnv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev");
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      // The forwarded label MUST embed this server's own bound port, exactly like a real
      // Codespaces forward does — codespacesForwardedOrigin (cors.ts) validates against
      // `${CODESPACE_NAME}-${apiPort}`, so a mismatched port is indistinguishable from an
      // attacker's Host and must be rejected (see the negative test below).
      const forwardedHost = `improbable-space-orb-abc123-${server.port}.app.github.dev`;
      const response = await fetchWithHost(server.port, "/runtime-config.json", {
        host: forwardedHost,
        "x-forwarded-proto": "https",
      });
      expect(response.status).toBe(StatusCodes.OK);
      const config = await response.json();
      expect(config.apiBaseUrl).toBe(`https://${forwardedHost}`);
      // No leftover proxy-prefix rewrite from the old two-port model.
      expect(config.apiBaseUrl).not.toContain("__tenkacloud-local-api");
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  /**
   * [#2906 round-2 audit] Same-origin container serving removed the Vite dev server's
   * `server.allowedHosts` gate, so runtime-config.json's Host trust check is the only
   * thing standing between an unauthenticated GET and the participant's login token —
   * without it, a DNS-rebinding page (loaded from an attacker hostname later re-pointed
   * to 127.0.0.1) reads this same-origin-per-browser response with no Origin header and
   * no CORS preflight to stop it. Pin that a Host neither matching this server's own
   * bound port nor a genuine (env-matched) Codespaces forward is rejected — including a
   * Codespaces-*shaped* Host sent without the matching env vars, and one embedding the
   * wrong port label.
   */
  it("rejects runtime-config.json for an untrusted Host header (#2906 DNS-rebinding audit)", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      for (const host of [
        "attacker.example",
        `attacker.example:${server.port}`,
        // Codespaces-shaped, but CODESPACE_NAME/GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
        // are not set in this test, so this must not be trusted just because it looks right.
        `improbable-space-orb-abc123-${server.port}.app.github.dev`,
      ]) {
        const response = await fetchWithHost(server.port, "/runtime-config.json", { host });
        expect(response.status).toBe(StatusCodes.FORBIDDEN);
        expect(await response.json()).toEqual({ error: "untrusted_host" });
      }
    } finally {
      await server.close();
    }
  });

  it("still routes /portal and /local under the reserved API prefixes when portalDistDir is set", async () => {
    const distDir = makePortalDist();
    const server = await startLocalPlayServer(
      0,
      { problems: [], participantToken: "a".repeat(43) },
      { portalDistDir: distDir },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/portal/leaderboard`);
      // Reaches the real API router (unauthorized, not the static-file/SPA fallback).
      expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
    } finally {
      await server.close();
    }
  });

  it("serves no static assets and no runtime-config.json when portalDistDir is unset (host/dev path)", async () => {
    const server = await startLocalPlayServer(0, {
      problems: [],
      participantToken: "a".repeat(43),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime-config.json`);
      expect(response.status).toBe(StatusCodes.NOT_FOUND);
      expect(await response.json()).toEqual({ error: "not_found" });
    } finally {
      await server.close();
    }
  });
});
