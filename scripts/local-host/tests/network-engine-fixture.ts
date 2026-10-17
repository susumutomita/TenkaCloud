import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { StartedContainer } from "../container/container-runner";
import { DockerHostingEngine } from "../docker-engine";
import { allocateNetworkSubnets, type NetworkSubnets } from "../docker-networks";
import type { InternetAccessRequest } from "../internet-access";
import { InternetGrantStore } from "../internet-grant-store";
import type { LocalNetworkGuard } from "../linux-network-guard";
import { egressComposeSource, requiredNetworkValue } from "../local-network";
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
    assertInternetTargets: () => {
      return undefined;
    },
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
  const grants = new InternetGrantStore(store);
  const reservations: string[] = [];
  const add = (
    name: string,
    publications = 0,
    catalogIndex = 0,
    http = false,
    egress: readonly InternetAccessRequest[] = [],
  ) => {
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
      catalogSnapshot?: { root: string; digest: string };
      problem: {
        internetAccess?: readonly InternetAccessRequest[];
        publicServices?: {
          id: string;
          service: string;
          port: number;
          purpose: string;
          applicationProtocol?: "http";
        }[];
      };
    };
    if (egress.length) {
      definition.problem.internetAccess = egress;
      definition.catalogSnapshot ??= { root: directory, digest: "synthetic-pinned-digest" };
      grants.put({
        eventId: job.eventId,
        problemId: job.problemId,
        definitionDigest: definition.catalogSnapshot.digest,
        requestIds: egress.map((entry) => entry.id).sort((a, b) => (a < b ? -1 : Number(a > b))),
        grantedAt: "2026-10-16T00:00:00Z",
      });
      job.definition = JSON.stringify(definition);
    }
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
        ...(http ? { applicationProtocol: "http" as const } : {}),
      }));
      job.definition = JSON.stringify(definition);
    }
    const subnets = allocateNetworkSubnets(
      egressComposeSource(
        definition.composeText,
        egress.map((entry) => entry.service),
      ),
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted.
      "10.240.0.0/24",
      reservations,
    );
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
    ) => Promise<void>;
    const admitted = admit.call(engine, job, {
      ...started,
      problem: { ...prepared.started.problem, terminal: { service: "synthetic-shell" } },
    });
    return { job, unit: started.unit, prepared, admitted };
  };
  engine.bindNetworkState({
    internetGrant: (eventId, problemId) => grants.get(eventId, problemId),
    jobs: () => store.jobs("event"),
    retain: (updates) => {
      calls.push("retain");
      for (const update of updates) store.putJob({ ...store.job(update.jobId), ...update });
    },
  });
  return {
    engine,
    grants,
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
