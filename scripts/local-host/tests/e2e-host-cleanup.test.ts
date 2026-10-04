import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../model";
import { HostStore } from "../store";
import { cleanOwnedDockerJobs } from "./e2e-host";

function writeFixture(databasePath: string): Job[] {
  const store = new HostStore(new Database(databasePath));
  const jobs: Job[] = ["first", "second", "never-started"].map((id) => ({
    jobId: id,
    eventId: "fixture-event",
    teamId: "fixture-team",
    problemId: id,
    definition: "{}",
    offset: 0,
    status: "FAILED",
    unit: id === "never-started" ? null : `${id}-owned-unit`,
  }));
  try {
    store.putEvent({
      eventId: "fixture-event",
      name: "Fixture cleanup",
      status: "DEPLOYING",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      expiresAt: 2_000_000_000,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: jobs.map((job) => ({
        problemId: job.problemId,
        name: job.problemId,
        definition: job.definition,
      })),
    });
    store.putTeam({
      teamId: "fixture-team",
      eventId: "fixture-event",
      internalSlug: "fixture-team",
      displayName: "Fixture team",
      loginKey: "fixture-only-key",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    });
    for (const job of jobs) store.putJob(job);
  } finally {
    store.close();
  }
  return jobs;
}

function readJobs(databasePath: string): Job[] {
  const store = new HostStore(new Database(databasePath));
  try {
    return store.jobs();
  } finally {
    store.close();
  }
}

for (const failOne of [false, true]) {
  test(`fixture cleanup ${failOne ? "retains failed ownership for retry" : "clears only stopped units"} in reopened SQLite`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tenka-e2e-cleanup-"));
    const databasePath = join(directory, "hosting.sqlite");
    const original = writeFixture(databasePath);
    const stopped: string[] = [];
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const clean = await cleanOwnedDockerJobs("unused-test-root", directory, {
        async stop(job) {
          stopped.push(job.jobId);
          if (failOne && job.jobId === "first") throw new Error("Test-only stop failure");
        },
      });
      expect(clean).toBe(!failOne);
      expect(stopped.sort()).toEqual(["first", "second"]);
      const saved = readJobs(databasePath);
      for (const job of saved) {
        if (job.jobId === "never-started" || (failOne && job.jobId === "first"))
          expect(original).toContainEqual(job);
        else expect(job).toMatchObject({ unit: null, status: "DELETED" });
      }
      expect(errors.mock.calls.length).toBe(failOne ? 1 : 0);
      const retried: string[] = [];
      expect(
        await cleanOwnedDockerJobs("unused-test-root", directory, {
          async stop(job) {
            retried.push(job.jobId);
          },
        }),
      ).toBe(true);
      expect(retried).toEqual(failOne ? ["first"] : []);
      expect(readJobs(databasePath).every((job) => job.unit === null)).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
