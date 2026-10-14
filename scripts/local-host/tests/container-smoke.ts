/**
 * Runs the hosted image the way a platform would and plays one Forensic Casebook through its
 * advertised origins: `docker build -f docker/host/Dockerfile -t tenkacloud-host .` first, then
 * `bun run test:host:container`. HTTP origins stand in for the TLS proxy (`--unsafe-http`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { type ForensicProjection, publicIdentityAnswer } from "./forensic-public-evidence";
import { organizerToken } from "./organizer-login";

const IMAGE = process.env.TENKACLOUD_HOST_IMAGE ?? "tenkacloud-host";
const NAME = `tenkacloud-host-smoke-${String(process.pid)}`;
const VOLUME = `${NAME}-data`;

function runDocker(args: string[]) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer-local tooling, like test:host:docker
  return spawnSync("docker", args, { encoding: "utf8" });
}

function docker(args: string[], check = true): string {
  const result = runDocker(args);
  if (check && result.status !== 0)
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return `${result.stdout}${check ? "" : result.stderr}`.trim();
}

/** Capture this private exec terminal only in memory; never include its output in diagnostics. */
function rotateOrganizerKey(): string {
  const result = runDocker([
    "exec",
    "-t",
    NAME,
    "bun",
    "run",
    "scripts/local-host/local.ts",
    "reset",
    "--data",
    "/data",
  ]);
  assert.ok(result.status === 0, "private organizer-key rotation failed");
  const key = /Organizer key \(shown once\): ([A-Za-z0-9_-]{43})/u.exec(result.stdout)?.[1];
  assert.ok(key, "private key display was absent");
  return key;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  await new Promise<void>((accept) => server.close(() => accept()));
  if (!address || typeof address === "string") throw new Error("no free port");
  return address.port;
}

async function api(
  origin: string,
  method: string,
  path: string,
  token = "",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function main(): Promise<void> {
  const refused = runDocker(["run", "--rm", IMAGE]);
  assert.notEqual(refused.status, 0, "the image must refuse to start without public origins");
  assert.match(refused.stderr + refused.stdout, /This image runs behind a TLS proxy/u);
  const adminPort = await freePort();
  const participantPort = await freePort();
  const admin = `http://127.0.0.1:${String(adminPort)}`;
  const participant = `http://127.0.0.1:${String(participantPort)}`;
  docker([
    "run",
    "--detach",
    "--tty",
    "--name",
    NAME,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--volume",
    `${VOLUME}:/data`,
    "--publish",
    `127.0.0.1:${String(adminPort)}:5174`,
    "--publish",
    `127.0.0.1:${String(participantPort)}:5175`,
    IMAGE,
    "--public-admin-origin",
    admin,
    "--public-participant-origin",
    participant,
    "--unsafe-http",
  ]);
  try {
    await waitFor("the participant health check", async () =>
      (await fetch(`${participant}/healthz`)).ok ? true : undefined,
    );
    const key = rotateOrganizerKey();
    const printed = docker(["logs", NAME], false);
    assert.ok(printed.includes("Organizer key: use make local-reset"), "missing recovery guidance");
    assert.ok(
      !printed.includes("Organizer key (shown once):"),
      "a public container startup TTY must never display a key",
    );
    assert.ok(!printed.includes(key), "the organizer key must not appear in container logs");

    for (const origin of [admin, participant]) {
      const page = await fetch(`${origin}/`);
      assert.equal(page.status, 200, `${origin}/ did not serve the application`);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
    }
    const config = (await (await fetch(`${admin}/runtime-config.json`)).json()) as Record<
      string,
      unknown
    >;
    assert.deepEqual(config, {
      mode: "local-host",
      apiBaseUrl: `${admin}/api`,
      participantPortalUrl: participant,
      role: "admin",
      hasAws: false,
    });

    const firstToken = await organizerToken({ admin, key });
    const token = await organizerToken({ admin, key });
    assert.ok(firstToken !== token, "each organizer-key login must receive an independent session");

    const catalog = await api(admin, "GET", "/host/catalog", token);
    const choices = (catalog.body.items as { problemId: string }[]).map((item) => item.problemId);
    assert.ok(choices.includes("forensic-casebook"));
    assert.ok(!choices.includes("ac26-crypto-battle"));

    const created = await api(admin, "POST", "/events", token, {
      name: "container smoke",
      teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
      problems: [{ problemId: "forensic-casebook" }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const eventId = String(created.body.eventId);
    const teams = created.body.teams as { teamLoginKey: string }[];

    assert.equal((await api(admin, "POST", `/events/${eventId}/deploy`, token)).status, 202);
    await waitFor("the event to be ready", async () => {
      const event = await api(admin, "GET", `/events/${eventId}`, token);
      return event.body.status === "READY" ? true : undefined;
    });
    const started = await api(admin, "PATCH", `/events/${eventId}/schedule`, token, {
      startNow: true,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    for (const team of teams) {
      const me = await api(participant, "GET", "/portal/me", team.teamLoginKey);
      assert.equal(me.status, 200, JSON.stringify(me.body));
    }
    const projection = await api(
      participant,
      "GET",
      "/portal/me/coordination/projection",
      teams[0]?.teamLoginKey ?? "",
    );
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    const initial = projection.body.projection as ForensicProjection;
    const identityCase = initial.cases.find((item) => item.id === "identity");
    const identity = identityCase?.evidence.find((item) => item.id === "I-IDP");
    const action = identityCase?.evidence.find((item) => item.id === "I-CLOUD");
    assert.ok(identity && action, "participant evidence must be available");
    const answer = publicIdentityAnswer(identity.content, action.content);
    const accepted = await api(
      participant,
      "POST",
      "/portal/me/coordination/op",
      teams[0]?.teamLoginKey,
      {
        op: {
          kind: "answer",
          id: "container-answer",
          revision: initial.revision,
          generation: initial.generation,
          caseId: "identity",
          questionId: "account",
          answer,
          evidenceIds: ["I-IDP", "I-CLOUD"],
        },
      },
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const before = accepted.body.projection as ForensicProjection;
    assert.equal(before.score, 20);
    docker(["restart", NAME]);
    await waitFor("participant recovery after container restart", async () =>
      (await fetch(`${participant}/healthz`)).ok ? true : undefined,
    );
    await organizerToken({ admin, key });
    for (const team of teams) {
      const recovered = await api(participant, "GET", "/portal/me", team.teamLoginKey);
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    }
    const recoveredProjection = await api(
      participant,
      "GET",
      "/portal/me/coordination/projection",
      teams[0]?.teamLoginKey ?? "",
    );
    assert.equal(recoveredProjection.status, 200, JSON.stringify(recoveredProjection.body));
    const after = recoveredProjection.body.projection as ForensicProjection;
    assert.equal(after.score, before.score, "the same official award must survive restart");
    assert.deepEqual(
      after.cases,
      before.cases,
      "evidence and solved questions must survive restart",
    );
    console.log(
      `PASS container smoke: ${IMAGE} served Forensic Casebook to 2 teams; answered public evidence and preserved keys, evidence and score across same-volume restart.`,
    );
  } finally {
    docker(["rm", "--force", NAME], false);
    docker(["volume", "rm", VOLUME], false);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
