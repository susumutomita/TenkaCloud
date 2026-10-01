import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { organizerToken } from "./organizer-login";

test("host root, login and history routes serve the same SPA before and after bootstrap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-root-entry-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const store = new HostStore(new Database(":memory:"));
  const key = "synthetic-root-route-key";
  const service = new HostingService(store, new CompetitionEngine(root, directory), key);
  const html =
    '<!doctype html><div id="root"></div><script type="module" src="/assets/entry.js"></script>';
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "host.html"), html);
  writeFileSync(join(directory, "assets", "entry.js"), 'document.title = "Root route fixture";');
  const host = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
  });
  try {
    const checkRoutes = async (token = "") => {
      for (const path of ["/", "/?from=terminal", "/login", "/events", "/events/example/teams"]) {
        const response = await fetch(`${host.origin}${path}`, {
          headers: {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe(html);
      }
    };
    await checkRoutes();
    await checkRoutes(await organizerToken({ admin: host.origin, key }));
    const script = await fetch(`${host.origin}/assets/entry.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toContain("Root route fixture");
  } finally {
    await host.close();
    await service.drain();
    service.flush();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
