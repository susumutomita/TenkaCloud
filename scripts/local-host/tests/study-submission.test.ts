import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { submissionCatalog } from "../submission-runtime";
import { repairArtifact, repairChecks, repairSource } from "./study-repair.test-helpers";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rows = [
  {
    problemId: "study-answer",
    version: "v1",
    name: "Fixed answer",
    instructions: "Solve the fixed problem locally.",
    artifact: '{"question":"6 * 7"}',
    points: 100,
    judge: { kind: "answer", answer: "42" },
  },
  {
    problemId: "study-repair",
    version: "v1",
    name: "Repair",
    instructions:
      "Report security and normal functionality honestly. Reports are modifiable self-reports.",
    artifact: repairArtifact,
    points: 100,
    judge: { kind: "self-report", checks: ["normal-functionality", "security"] },
  },
];

test("offline repair checks reject both the vulnerable implementation and blocking every function", () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-study-checks-"));
  try {
    writeFileSync(join(directory, "checks.mjs"), repairChecks);
    const results = [
      [repairSource, { "normal-functionality": true, security: false }],
      ["export const canRead = () => false;", { "normal-functionality": false, security: true }],
      [
        "export const canRead = (owner, sessionUser) => owner === sessionUser;",
        { "normal-functionality": true, security: true },
      ],
    ] as const;
    for (const [source, expected] of results) {
      writeFileSync(join(directory, "exercise.mjs"), source);
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Fixed synthetic participant-side fixture only; the organizer never executes submissions.
      const ran = spawnSync("node", [join(directory, "checks.mjs")], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(ran.status).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual(expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submission catalog validates fixed grading and repair checks without changing default catalogs", () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-study-catalog-"));
  const path = join(directory, "catalog.json");
  try {
    expect(submissionCatalog(undefined)).toEqual([]);
    writeFileSync(path, JSON.stringify(rows));
    const first = submissionCatalog(path);
    expect(first).toHaveLength(2);
    expect(first[0]?.definition).not.toContain('"answer":"42"');
    expect(submissionCatalog(path)).toEqual(first);
    for (const invalid of [
      [{ ...rows[0], points: -100 }],
      [rows[0], rows[0]],
      [{ ...rows[1], judge: { kind: "self-report", checks: ["security"] } }],
      [{ ...rows[1], judge: { kind: "self-report", checks: ["security", "other"] } }],
      [{ ...rows[0], problemId: "../escape" }],
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(() => submissionCatalog(path)).toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Node24 organizer / separate participant process: fixed edition, gates, six teams, retry and durable restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-study-http-"));
  const catalog = join(directory, "catalog.json");
  writeFileSync(catalog, JSON.stringify(rows), { mode: 0o600 });
  const build = spawnSync(process.execPath, ["run", "scripts/local-host/build-node.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(build.status).toBe(0);
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- CI pins Node24; fixture secrets use a private pipe, never argv or output.
  const child = spawn("node", [join(root, ".tenkacloud/node-host/study.mjs"), directory, catalog], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  async function next() {
    const line = await output.next();
    if (line.done) throw new Error(`Study host exited: ${stderr}`);
    return JSON.parse(line.value) as Record<string, unknown>;
  }
  const keyPipe = createInterface({ input: child.stdio[3] as Readable })[Symbol.asyncIterator]();
  const keyLine = await keyPipe.next();
  expect(keyLine.done).toBe(false);
  const key = String(keyLine.value);
  let addresses = await next();
  const control = async (command: unknown) => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return next();
  };
  async function api(
    kind: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    token = "",
    nonce?: string,
  ) {
    const response = await fetch(`${String(addresses[kind])}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(nonce ? { "idempotency-key": nonce } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  try {
    const login = await api("admin", "/host/login", "POST", { key });
    expect(login.status).toBe(200);
    const admin = String(login.body.idToken);
    const made = await api(
      "admin",
      "/events",
      "POST",
      {
        name: "Thursday study",
        teams: Array.from({ length: 6 }, (_, index) => ({ internalSlug: `team-${index}` })),
        problems: [{ problemId: "study-answer" }, { problemId: "study-repair" }],
      },
      admin,
    );
    expect(made.status).toBe(201);
    const eventId = String(made.body.eventId);
    const teams = made.body.teams as { teamId: string; teamLoginKey: string }[];
    const a = teams[0];
    expect(a).toBeDefined();
    const token = a?.teamLoginKey ?? "";
    expect((await api("admin", `/events/${eventId}/deploy`, "POST", {}, admin)).status).toBe(202);
    await control({ kind: "drain" });
    const before = await api("participant", "/portal/me", "GET", undefined, token);
    expect(JSON.stringify(before.body)).not.toContain("artifact");
    expect(
      (
        await api(
          "participant",
          "/portal/me/submit-flag",
          "POST",
          { problemId: "study-answer", flag: "{}" },
          token,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api(
          "admin",
          `/events/${eventId}/schedule`,
          "PATCH",
          { startNow: true, endsAt: "2026-10-15T11:00:00Z" },
          admin,
        )
      ).status,
    ).toBe(200);
    const view = await api("participant", "/portal/me", "GET", undefined, token);
    expect(view.status).toBe(200);
    const problems = view.body.problems as {
      problemId: string;
      submission: { edition: string; artifact: string; assurance: string };
      jobId: string;
    }[];
    const answer = problems.find((p) => p.problemId === "study-answer");
    const repair = problems.find((p) => p.problemId === "study-repair");
    expect(answer).toBeDefined();
    expect(repair).toBeDefined();
    expect(JSON.stringify(view.body)).not.toContain('"answer":"42"');
    expect(JSON.stringify(view.body)).not.toContain('"digest"');
    const envelope = { edition: answer?.submission.edition, answer: "42" };
    const submit = (key = token, value: unknown = envelope, nonce?: string, extra = {}) =>
      api(
        "participant",
        "/portal/me/submit-flag",
        "POST",
        { problemId: "study-answer", flag: JSON.stringify(value), ...extra },
        key,
        nonce,
      );
    expect((await submit("unknown")).status).toBe(401);
    const editionMismatch = await submit(token, { ...envelope, edition: "other" });
    expect(editionMismatch.status).toBe(409);
    expect(editionMismatch.body.kind).toBe("edition_mismatch");
    const malformedAnswer = await submit(token, { ...envelope, answer: 42 });
    expect(malformedAnswer.status).toBe(400);
    expect(malformedAnswer.body.kind).toBe("request_failed");
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Negative SSRF input is never fetched.
    expect((await submit(token, { ...envelope, url: "http://169.254.169.254/" })).status).toBe(400);
    expect((await submit(token, { ...envelope, points: 9999 })).status).toBe(400);
    expect((await submit(token, envelope, undefined, { teamId: teams[1]?.teamId })).status).toBe(
      400,
    );
    expect((await submit(token, envelope, undefined, { eventId: "other" })).status).toBe(400);
    expect((await submit(token, envelope, undefined, { problemId: "not-in-event" })).status).toBe(
      409,
    );
    expect((await submit(token, { ...envelope, answer: "wrong" })).body.kind).toBe("wrong");
    expect(
      (await api("admin", `/events/${eventId}/progression-gate`, "PUT", {}, admin)).status,
    ).toBe(400);
    const results = await Promise.all(
      teams.map((team, index) => submit(team.teamLoginKey, envelope, `study-answer-${index}`)),
    );
    expect(results.every((result) => result.status === 200 && result.body.scoreDelta === 100)).toBe(
      true,
    );
    expect((await submit(token, envelope, "study-answer-0")).body).toEqual(results[0]?.body ?? {});
    expect((await submit(token, { ...envelope, answer: "changed" }, "study-answer-0")).status).toBe(
      409,
    );
    expect((await submit()).body.kind).toBe("already_scored");
    const report = (checks: unknown, nonce?: string) =>
      api(
        "participant",
        "/portal/me/submit-flag",
        "POST",
        {
          problemId: "study-repair",
          flag: JSON.stringify({ edition: repair?.submission.edition, checks }),
        },
        token,
        nonce,
      );
    expect((await report({ security: true })).status).toBe(400);
    expect((await report({ "normal-functionality": false, security: true })).body.kind).toBe(
      "wrong",
    );
    const accepted = await report(
      { "normal-functionality": true, security: true },
      "study-repair-0",
    );
    expect(accepted.body.assurance).toBe("self-reported");
    expect(accepted.body.scoreDelta).toBe(100);
    const board = await api("participant", "/portal/leaderboard", "GET", undefined, token);
    const entries = board.body.entries as { teamId: string; score: number; rank: number }[];
    expect(entries).toHaveLength(6);
    expect(entries.find((entry) => entry.teamId === a?.teamId)).toMatchObject({
      score: 200,
      rank: 1,
    });
    expect(entries.filter((entry) => entry.score === 100).every((entry) => entry.rank === 2)).toBe(
      true,
    );
    const history = await api("participant", "/portal/me/score-events", "GET", undefined, token);
    expect(history.body.entries).toContainEqual(
      expect.objectContaining({
        source: "self-report",
        assurance: "self-reported",
        edition: repair?.submission.edition,
      }),
    );
    const detail = await api(
      "admin",
      `/events/${eventId}?withScoreEvents=true`,
      "GET",
      undefined,
      admin,
    );
    expect(JSON.stringify(detail.body)).toContain('"assurance":"self-reported"');
    // The platform has no participant callback URL and no code-execution path.
    // A restart represents disconnect/reconnect; canonical receipts and scores survive.
    const oldOrigin = String(addresses.participant);
    writeFileSync(
      catalog,
      JSON.stringify(
        rows.map((row) =>
          row.problemId === "study-answer"
            ? { ...row, judge: { kind: "answer", answer: "new answer" } }
            : row,
        ),
      ),
    );
    addresses = await control({ kind: "restart" });
    expect(
      await fetch(`${oldOrigin}/api/portal/me`).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect((await submit(token, envelope, "study-answer-0")).body).toEqual(results[0]?.body ?? {});
    expect(
      (await report({ "normal-functionality": true, security: true }, "study-repair-0")).body,
    ).toEqual(accepted.body);
    expect((await api("participant", "/portal/leaderboard", "GET", undefined, token)).body).toEqual(
      board.body,
    );
    const jobId = answer?.jobId;
    expect(
      (await api("admin", `/events/${eventId}/deployments/${jobId}/stop`, "POST", {}, admin))
        .status,
    ).toBe(202);
    await control({ kind: "drain" });
    expect((await submit()).status).toBe(409);
    expect(
      (await api("admin", `/events/${eventId}/deployments/${jobId}/restart`, "POST", {}, admin))
        .status,
    ).toBe(202);
    await control({ kind: "drain" });
    expect((await submit()).body.kind).toBe("already_scored");
    await control({ kind: "clock", now: Date.parse("2026-10-15T11:00:00Z") });
    expect((await submit()).status).toBe(409);
    // Previously acknowledged receipts remain queryable after the cutoff, with no new award.
    expect((await submit(token, envelope, "study-answer-0")).body).toEqual(results[0]?.body ?? {});
  } finally {
    child.stdin.write('{"kind":"stop"}\n');
    child.stdin.end();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode, stderr).toBe(0);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
