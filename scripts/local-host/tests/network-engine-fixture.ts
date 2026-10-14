import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { StartedContainer } from "../container/container-runner";
import { DockerHostingEngine } from "../docker-engine";
import { allocateNetworkSubnets, type NetworkSubnets } from "../docker-networks";
import type { LocalNetworkGuard } from "../linux-network-guard";
import { requiredNetworkValue } from "../local-network";
import type { Job } from "../model";
import { HostStore } from "../store";

/** Real lifecycle/store code; transport never touches Docker or firewall configuration. */
export function networkEngineFixture() {
  const directory = mkdtempSync(join(tmpdir(), "tc-network-lifecycle-"));
  const calls: string[] = [];
  let now = 1000;
  const record = (action: string) => () => {
    calls.push(action);
  };
  const guard: LocalNetworkGuard = {
    preflight: record("preflight"),
    install: record("install"),
    verify: record("verify"),
    verifyNetworks: record("verifyNetworks"),
    audit: async () => {
      calls.push("audit");
    },
    occupiedRoutes: () => [],
    remove: record("remove"),
    update: record("update"),
    endpoints: () => [],
    routePublications: record("route"),
    quarantine: record("quarantine-sync"),
    quarantineAsync: async () => {
      calls.push("quarantine");
    },
    stopOwned: async () => {
      calls.push("stop-owned");
    },
    resetStopped: record("reset-sync"),
    resetStoppedAsync: async () => {
      calls.push("reset");
    },
  };
  const engine = new DockerHostingEngine(
    fileURLToPath(new URL("../../../", import.meta.url)),
    directory,
    undefined,
    true,
    guard,
    async () => {
      throw new Error("Unvalidated Compose must never execute");
    },
    () => now,
  );
  const problem = requiredNetworkValue(engine.catalog()[0]);
  const store = new HostStore(new Database(":memory:"));
  store.putEvent({
    eventId: "event",
    name: "Network lifecycle",
    status: "READY",
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
    expiresAt: 1,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem],
  });
  const reservations: string[] = [];
  const add = (name: string, publications = 0, catalogIndex = 0) => {
    const problem = requiredNetworkValue(engine.catalog()[catalogIndex]);
    const event = store.event("event");
    if (!event.problems.some((entry) => entry.problemId === problem.problemId))
      store.putEvent({ ...event, problems: [...event.problems, problem] });
    store.putTeam({
      teamId: name,
      eventId: "event",
      internalSlug: name,
      displayName: name,
      loginKey: `synthetic-${name}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    });
    const job: Job = {
      jobId: name,
      eventId: "event",
      teamId: name,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      networkIsolationVersion: 1,
      unit: null,
    };
    const definition = JSON.parse(job.definition) as {
      composeText: string;
      problem: {
        publicServices?: { id: string; service: string; port: number; purpose: string }[];
      };
    };
    if (publications) {
      const document = parse(definition.composeText);
      const service = "public-fixture";
      document.services[service] = { image: "alpine:3.22" };
      definition.composeText = stringify(document);
      definition.problem.publicServices = Array.from({ length: publications }, (_, index) => ({
        id: `public-${index}`,
        service,
        port: 8000 + index,
        purpose: "Synthetic bounded capability",
      }));
      job.definition = JSON.stringify(definition);
    }
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocator, no connection
    const subnets = allocateNetworkSubnets(definition.composeText, "10.240.0.0/24", reservations);
    reservations.push(...Object.values(subnets));
    const prepare = Reflect.get(engine, "plan") as (
      job: Job,
      verifySources: boolean,
      subnets: NetworkSubnets,
    ) => { started: StartedContainer; composeText: string };
    const prepared = prepare.call(engine, job, false, subnets);
    const started = {
      ...prepared.started,
      unit: publications
        ? {
            ...prepared.started.unit,
            publishedServiceIds: Array.from(
              { length: publications },
              (_, index) => `public-${index}`,
            ),
          }
        : prepared.started.unit,
    };
    writeFileSync(prepared.started.unit.composePath, prepared.composeText, { mode: 0o600 });
    job.unit = JSON.stringify(started.unit);
    store.putJob(job);
    const admit = Reflect.get(engine, "admitRunning") as (
      job: Job,
      started: StartedContainer,
    ) => void;
    admit.call(engine, job, {
      ...started,
      problem: { ...prepared.started.problem, terminal: { service: "synthetic-shell" } },
    });
    return { job, unit: started.unit, prepared };
  };
  engine.bindNetworkState({
    jobs: () => store.jobs("event"),
    retain: (updates) => {
      calls.push("retain");
      for (const update of updates) store.putJob({ ...store.job(update.jobId), ...update });
    },
  });
  return {
    engine,
    store,
    guard,
    calls,
    add,
    setNow: (value: number) => {
      now = value;
    },
    close: async () => {
      await engine.drainNetworkChecks();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
