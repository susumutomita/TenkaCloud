import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

export async function apiDocsFixture() {
  const directory = mkdtempSync(join(tmpdir(), "tenka-api-docs-"));
  const store = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture((path) => new Database(path));
  const key = store.ensureLocalOrganizerKey().key;
  if (!key) throw new Error("Fixture organizer key was not initialized.");
  let now = Date.now();
  const service = new HostingService(store, engine, randomToken(), () => now);
  const admin = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
  });
  const participant = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
  });
  return {
    admin,
    participant,
    key,
    store,
    service,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    async close() {
      await service.drain();
      for (const job of store.jobs()) if (job.unit) await engine.stop(job);
      await participant.close();
      await admin.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
