import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

/** Exercises production on-demand planning/ownership without invoking Docker or AWS. */
class OnDemandExerciseFixture extends ExerciseFixture {
  readonly supportsOnDemand = true;
  override catalog() {
    return super.catalog().map((problem) => ({
      ...problem,
      definition: JSON.stringify({
        composeText:
          "services:\n  exercise:\n    image: synthetic-fixture\n    ports: ['127.0.0.1:20001:80']\n",
      }),
    }));
  }
  containerCost() {
    return { services: 1, memoryMiB: 512 };
  }
}
export async function apiDocsFixture(onDemand = false) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-api-docs-"));
  const store = new HostStore(new Database(":memory:"));
  const Engine = onDemand ? OnDemandExerciseFixture : ExerciseFixture;
  const engine = new Engine((path) => new Database(path));
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
