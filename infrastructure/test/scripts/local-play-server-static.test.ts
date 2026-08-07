import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalPlayServer } from "../../../scripts/local-play/server";

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
