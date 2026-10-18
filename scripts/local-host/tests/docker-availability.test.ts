import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localCompetitionEngine } from "../application";
import { randomToken } from "../auth";
import { apiRequest } from "../bench/state-setup";
import { dockerAvailability } from "../container/compose-cli";
import { parseOptions } from "../options";
import { HostingService } from "../service";
import { HostStore } from "../store";

for (const missing of ["cli", "compose", "daemon", "healthy"])
  test(`Docker availability ${missing} uses only bounded read-only version/info probes`, () => {
    const calls: string[] = [];
    const result = dockerAvailability((command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (missing === "cli") return false;
      if (missing === "compose" && args.includes("version")) return false;
      if (missing === "daemon" && args.includes("info")) return false;
      return true;
    });
    expect(result.available).toBe(missing === "healthy");
    if (missing !== "healthy") expect(result.reason).toContain("Native problems remain available");
    expect(
      calls.every(
        (call) => call.endsWith("version") || call === "docker info --format {{.ServerVersion}}",
      ),
    ).toBe(true);
  });

test("unavailable Docker is warned and cannot enter new events while native problems remain selectable", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "tc-no-docker-catalog-"));
  const database = new Database(":memory:");
  const store = new HostStore(database);
  const status = dockerAvailability(() => false);
  if (!status.reason) throw new Error("Expected Docker unavailability reason");
  const engine = localCompetitionEngine(root, directory, parseOptions([], root, {}), status);
  const service = new HostingService(store, engine, randomToken());
  try {
    const { key } = store.ensureLocalOrganizerKey();
    const login = await service.admin(
      apiRequest({ method: "POST", path: "/host/login", token: "", body: { key } }),
    );
    const { idToken } = login.body as { idToken: string };
    const catalog = await service.admin(
      apiRequest({ method: "GET", path: "/host/catalog", token: idToken }),
    );
    const { items, warnings } = catalog.body as {
      items: { problemId: string; runtime: string }[];
      warnings: string[];
    };
    expect(warnings).toEqual([status.reason]);
    expect(items.some((item) => item.runtime === "docker")).toBe(false);
    expect(items.some((item) => item.problemId === "crypto-battle")).toBe(true);
    const create = (problemId: string) =>
      service.admin(
        apiRequest({
          method: "POST",
          path: "/events",
          token: idToken,
          body: {
            name: "No daemon",
            teams: [{ internalSlug: "alpha" }],
            problems: [{ problemId }],
          },
        }),
      );
    await expect(create("sqli-demo")).rejects.toMatchObject({ status: 422 });
    expect((await create("crypto-battle")).status).toBe(201);
    const healthy = localCompetitionEngine(root, directory, parseOptions([], root, {}), {
      available: true,
    });
    expect(healthy.catalog().some((item) => item.runtime === "docker")).toBe(true);
    expect(healthy.catalogWarnings).toEqual([]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
