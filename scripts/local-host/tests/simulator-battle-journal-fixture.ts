import type { Job } from "../model";
import { parseBattleProbeDescriptor } from "../simulator-battle-probe";
import { simulatorBattleUptimeTarget } from "../simulator-battle-uptime-target";
import { simulatorStackOrigin } from "../simulator-stack-origin";
import type { HostStore } from "../store";
export const scope = { kind: "owned-battle-probe-journal" as const };
export function seed(host: HostStore, team = "team") {
  host.putEvent({
    eventId: "event",
    name: "fixture",
    status: "READY",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 1,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  host.putTeam({
    teamId: team,
    eventId: "event",
    internalSlug: team,
    displayName: team,
    loginKey: team,
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
  });
  const job: Job = {
    jobId: `job-${team}`,
    eventId: "event",
    teamId: team,
    problemId: "hello-world-battle",
    definition: JSON.stringify({
      kind: "cloudformation",
      problemId: "hello-world-battle",
      scoring: { kind: "uptime-flat" },
    }),
    offset: 0,
    status: "COMPLETE",
    deployedAt: 1000,
    unit: null,
  };
  job.unit = JSON.stringify({
    kind: "cloudformation",
    stackId: "stack",
    outputs: { InstanceId: "i-one" },
    origin: simulatorStackOrigin(job),
  });
  host.putJob(job);
  return job;
}
export function descriptor(
  job: Job,
  key = "a".repeat(32),
  domain = `mono-${"b".repeat(32)}`,
  origin = "http://127.0.0.1:1234",
  handle = "c".repeat(64),
) {
  const { owner, generation } = simulatorBattleUptimeTarget(job);
  const wire = {
    owner: handle,
    deployment: "2".repeat(64),
    lease: "3".repeat(64),
    backendIncarnation: "4".repeat(64),
  };
  const lease = { id: "lease", incarnation: wire.lease };
  const map = (slot: "frontend" | "api") => {
    const path = slot === "frontend" ? "/" : "/healthz";
    const port = slot === "frontend" ? 80 : 8080;
    return {
      wireBinding: wire,
      service: { name: slot, port, path },
      binding: {
        owner,
        lease,
        slot,
        backendIncarnation: wire.backendIncarnation,
        target: {
          localIP: "192.0.2.1",
          peerIP: "192.0.2.2",
          localMAC: "02:00:00:00:00:01",
          peerMAC: "02:00:00:00:00:02",
          peerPort: port,
          path,
        },
      },
    };
  };
  return parseBattleProbeDescriptor({
    version: 1,
    kind: "battle-probe-correlation-only",
    owner,
    generation,
    slot: "frontend",
    key,
    deadline: { domain, ticksMs: 8000 },
    receipt: {
      version: 1,
      handle,
      clockDomain: domain,
      binding: {
        owner,
        lease,
        endpoints: {
          frontend: `${origin}/_simulator/v1/battle-capabilities/${handle}/frontend`,
          api: `${origin}/_simulator/v1/battle-capabilities/${handle}/api`,
        },
      },
      slots: { frontend: map("frontend"), api: map("api") },
    },
  });
}
export function snapshot(d: ReturnType<typeof descriptor>, settled = false) {
  return {
    version: 2,
    clockDomain: d.deadline.domain,
    binding: d.receipt.slots.frontend.wireBinding,
    service: d.receipt.slots.frontend.service,
    key: d.key,
    startedAtMs: 100,
    deadlineMs: 8000,
    resultReady: true,
    settled,
    result: { error: "deadline_exceeded" },
  };
}
