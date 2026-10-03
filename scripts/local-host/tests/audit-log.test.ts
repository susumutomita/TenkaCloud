import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { HostingService } from "../service";
import { HostStore } from "../store";
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
import { ExerciseFixture } from "./exercise-fixture";

const engine = () => new ExerciseFixture((path) => new Database(path));

test("fresh hosts do not create dedicated audit storage", async () => {
  const store = new HostStore(new Database(":memory:"));
  try {
    const service = new HostingService(store, engine(), randomToken());
    await service.recover();
    expect(
      store.statement("SELECT name FROM sqlite_master WHERE name LIKE 'host_audit_%'").all(),
    ).toEqual([]);
    expect(store.featureFlags().audit).toBe(false);
  } finally {
    store.close();
  }
});

test("legacy audit settings and history remain inert across startup, mutations and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-audit-retirement-"));
  const path = join(directory, "host.sqlite");
  let store = new HostStore(new Database(path));
  try {
    seedLegacyAudit(store);
    rejectLegacyAuditWrites(store);
    const before = legacyAuditSnapshot(store);
    const key = store.ensureLocalOrganizerKey().key;
    for (let restart = 0; restart < 2; restart++) {
      const service = new HostingService(store, engine(), randomToken());
      await service.recover();
      const login = await service.admin({
        method: "POST",
        path: "/host/login",
        query: new URLSearchParams(),
        token: "",
        body: { key },
      });
      expect(login.status).toBe(200);
      const { idToken } = login.body as { idToken: string };
      expect(
        (
          await service.admin({
            method: "POST",
            path: "/events",
            query: new URLSearchParams(),
            token: idToken,
            body: {
              name: "Retired audit",
              teams: [{ internalSlug: "one" }],
              problems: [{ problemId: "sqli-demo" }],
            },
          })
        ).status,
      ).toBe(201);
      expect(store.featureFlags().audit).toBe(false);
      expect(legacyAuditSnapshot(store)).toEqual(before);
      expect(store.events()).toHaveLength(restart + 1);
      store.close();
      store = new HostStore(new Database(path));
    }
    expect(legacyAuditSnapshot(store)).toEqual(before);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
