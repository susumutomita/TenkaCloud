import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "../auth";
import type { HostedEvent, Job, RuntimeEngine, Team } from "../model";
import { startLocalHost } from "../server";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("shutdown confirms a guard revocation queued while relays close before SQLite closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tc-shutdown-guard-"));
  const revocations = new Set<Promise<void>>();
  let retained: Parameters<NonNullable<RuntimeEngine["bindNetworkState"]>>[0] | undefined;
  let halt: Promise<void> | undefined;
  const event: HostedEvent = {
    eventId: id(),
    name: "Relay shutdown race",
    status: "READY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startsAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  };
  const team: Team = {
    teamId: id(),
    eventId: event.eventId,
    internalSlug: "alpha",
    displayName: "Alpha",
    loginKey: "synthetic-relay-team-key",
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
  };
  const job: Job = {
    jobId: id(),
    eventId: event.eventId,
    teamId: team.teamId,
    problemId: "relay-lab",
    definition: "{}",
    offset: 0,
    status: "COMPLETE",
    unit: "isolated-unit",
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected gameplay call.");
  };
  const engine: RuntimeEngine = {
    catalog: () => [],
    start: unavailable,
    stop: unavailable,
    recover: async () => undefined,
    pause: unavailable,
    resume: unavailable,
    view: unavailable,
    submit: unavailable,
    hint: unavailable,
    surface: () => {
      throw new Error("Unexpected surface access.");
    },
    bindNetworkState: (state) => {
      retained = state;
    },
    drainNetworkChecks: async () => {
      while (revocations.size) await Promise.all(revocations);
    },
    // A relay ownership audit failed after the first drain; its guard halt is queued but,
    // like the Docker adapter, closing transports does not wait for it.
    closeTransports: async () => {
      halt = Bun.sleep(20).then(() =>
        retained?.retain([
          {
            jobId: job.jobId,
            unit: "isolated-unit",
            status: "STOPPED",
            error: "Competition guard failed; runtime was stopped and requires verified recovery.",
          },
        ]),
      );
      const tracked = halt.catch(() => undefined).finally(() => revocations.delete(tracked));
      revocations.add(tracked);
    },
  };
  try {
    const host = await startLocalHost(
      root,
      {
        dataDirectory: directory,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: { start: 58140, end: 58179 },
      },
      (_, store) => {
        store.putEvent(event);
        store.putTeam(team);
        store.putJob(job);
        return engine;
      },
      () => undefined,
    );
    await host.stop();
    const outcome = await halt?.then(
      () => "retained",
      (error: unknown) => String(error),
    );
    const store = new HostStore(new Database(host.databasePath));
    try {
      const recorded = store.job(job.jobId);
      expect({ outcome, status: recorded.status, error: recorded.error }).toEqual({
        outcome: "retained",
        status: "STOPPED",
        error: "Competition guard failed; runtime was stopped and requires verified recovery.",
      });
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
