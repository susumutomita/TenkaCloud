import assert from "node:assert/strict";
import { type RawData, WebSocket } from "ws";
import { randomToken } from "../auth";
import type { HostStore } from "../store";

interface SmokeTeam {
  readonly teamId: string;
  readonly teamLoginKey: string;
}
export interface DockerTerminalSmoke {
  api<T>(
    role: "host" | "portal",
    path: string,
    method?: string,
    body?: unknown,
    credential?: string,
  ): Promise<T>;
  drain(): Promise<void>;
  restart(): Promise<void>;
  store(): HostStore;
  portalOrigin(): string;
  containers(jobId: string, includeStopped?: boolean): string[];
}
const PROBLEM = "db-a1-table-primary-key";
const CHECKS = [
  "members-table-has-primary-key",
  "members-rows-loaded",
  "duplicate-insert-rejected",
] as const;

function frameText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

/** Uses the same one-use handoff and WebSocket as the participant UI, not docker exec. */
async function terminalCommand(
  smoke: DockerTerminalSmoke,
  team: SmokeTeam,
  command: string,
): Promise<string> {
  const { ticket } = await smoke.api<{ ticket: string }>(
    "portal",
    `/portal/me/problems/${PROBLEM}/terminal-handoff`,
    "POST",
    {},
    team.teamLoginKey,
  );
  const origin = smoke.portalOrigin();
  const url = `${origin.replace(/^http/u, "ws")}/api/portal/me/problems/${PROBLEM}/terminal?ticket=${ticket}`;
  const socket = new WebSocket(url, { headers: { origin }, handshakeTimeout: 10_000 });
  const marker = `TC_SMOKE_${randomToken()}`;
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(
      () => finish(new Error(`Terminal command timed out: ${output.slice(-2000)}`)),
      30_000,
    );
    socket.once("open", () => {
      socket.send(
        JSON.stringify({ type: "input", data: `(${command}) && printf '\\n%s\\n' '${marker}'\n` }),
      );
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(frameText(raw)) as { type: string; data?: string };
      if (frame.type === "data") {
        output += frame.data ?? "";
        if (output.length > 64 * 1024) finish(new Error("Unexpectedly large terminal output."));
        else if (output.includes(marker)) finish();
      } else if (frame.type === "exit") finish(new Error("Terminal exited before completion."));
    });
    socket.once("error", () => finish(new Error("Participant terminal connection failed.")));
    socket.once("close", () => finish(new Error("Participant terminal closed early.")));
  });
}

const sql = (statement: string) =>
  `psql -U participant -d drill -v ON_ERROR_STOP=1 -At -c "${statement}"`;

/** Real PostgreSQL state, multi-check scoring, team isolation, and disk-preserving resume. */
export async function verifyDockerTerminal(smoke: DockerTerminalSmoke): Promise<string[]> {
  const event = await smoke.api<{ eventId: string; teams: SmokeTeam[] }>(
    "host",
    "/events",
    "POST",
    {
      name: "PostgreSQL terminal integration check",
      teams: [{ internalSlug: "db-team-a" }, { internalSlug: "db-team-b" }],
      problems: [{ problemId: PROBLEM }],
    },
  );
  const [first, second] = event.teams;
  assert.ok(first && second);
  await smoke.api("host", `/events/${event.eventId}/deploy`, "POST", {});
  await smoke.drain();
  await smoke.api("host", `/events/${event.eventId}/schedule`, "PATCH", { startNow: true });
  for (const team of [first, second]) {
    await smoke.api(
      "portal",
      `/portal/me/problems/${PROBLEM}/container/start`,
      "POST",
      {},
      team.teamLoginKey,
    );
    await smoke.drain();
    const job = smoke.store().jobs(event.eventId, team.teamId)[0];
    assert.equal(job?.status, "COMPLETE", job?.error ?? "No terminal job.");
  }
  const job = smoke.store().jobs(event.eventId, first.teamId)[0];
  assert.ok(job);
  const containerIds = smoke.containers(job.jobId);
  assert.ok(containerIds.length > 0);
  const submit = (flagId: string) =>
    smoke.api<{ kind: string; totalScore: number }>(
      "portal",
      "/portal/me/submit-flag",
      "POST",
      { problemId: PROBLEM, flag: "rescan", flagId },
      first.teamLoginKey,
    );
  // The shared scorer intentionally retains penalties below zero; prose must match it.
  assert.equal((await submit(CHECKS[0])).kind, "wrong");
  assert.equal(smoke.store().team(first.teamId).score, -2);
  const output = await terminalCommand(
    smoke,
    first,
    sql(
      "create table training.members (email text primary key, display_name text not null); " +
        "insert into training.members select distinct on (email) email, display_name " +
        "from training.members_unkeyed order by email, id; " +
        "select 'rows=' || count(*) from training.members;",
    ),
  );
  assert.ok(output.includes("rows=7"));
  const isolated = await terminalCommand(
    smoke,
    second,
    sql("select 'isolated=' || (to_regclass('training.members') is null)::text;"),
  );
  assert.ok(isolated.includes("isolated=true"));
  for (const check of CHECKS) assert.equal((await submit(check)).kind, "ok");
  assert.equal(smoke.store().team(first.teamId).score, 98);
  assert.equal(smoke.store().team(second.teamId).score, 0);
  assert.equal((await submit(CHECKS[0])).kind, "already_scored");
  await smoke.api("host", `/events/${event.eventId}/deployments/${job.jobId}/stop`, "POST", {});
  await smoke.drain();
  assert.deepEqual(smoke.containers(job.jobId), []);
  assert.deepEqual(smoke.containers(job.jobId, true), containerIds);
  await smoke.restart();
  assert.equal(smoke.store().team(first.teamId).score, 98);
  await smoke.api("host", `/events/${event.eventId}/deployments/${job.jobId}/restart`, "POST", {});
  await smoke.drain();
  assert.deepEqual(smoke.containers(job.jobId), containerIds);
  const resumed = await terminalCommand(
    smoke,
    first,
    sql("select 'rows=' || count(*) from training.members;"),
  );
  assert.ok(resumed.includes("rows=7"));
  assert.equal((await submit(CHECKS[2])).kind, "already_scored");
  await smoke.api("host", `/events/${event.eventId}`, "DELETE", {});
  await smoke.drain();
  for (const owned of smoke.store().jobs(event.eventId)) {
    assert.equal(owned.status, "DELETED", owned.error ?? "");
    assert.deepEqual(smoke.containers(owned.jobId, true), []);
  }
  return [
    "Real participant WebSocket terminal creates PostgreSQL data; another team's database stays untouched",
    "Three live database checkpoints award once, including retained negative penalties and retry receipts",
    "The same PostgreSQL container, seven rows and score survive stop, host restart and resume; owned teardown removes both projects",
  ];
}
