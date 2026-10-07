import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest, BENCH_ORGANIZER, type CreatedEvent, HOST_KEY } from "../bench/state-setup";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const endpoint = "/portal/me/coordination/op";
const nonce = "bound-run-operation";

function readyOperation(problemId: string, p: { revision: number; round: number }) {
  if (problemId === "pi-siege")
    return { kind: "ready", requestId: "run_ready", revision: p.revision, round: p.round };
  if (problemId === "session-defense")
    return { kind: "ready", id: "run_ready", revision: p.revision };
  return { kind: "ready" };
}

for (const problemId of ["ac26-crypto-battle", "pi-siege", "session-defense"]) {
  test(`${problemId}: HTTP rejects foreign and stale runs before ticks or saved retries`, async () => {
    const data = mkdtempSync(join(tmpdir(), "tenka-coordination-run-"));
    const database = join(data, "host.sqlite");
    let clock = Date.parse("2026-10-07T00:00:00Z");
    let store = new HostStore(new Database(database));
    const engine = new CompetitionEngine(root, data, false);
    let service = new HostingService(store, engine, HOST_KEY, () => clock);
    let portal: HttpHost | undefined;
    const plugin = spyOn(engine, "coordinationPlugin");
    async function attach() {
      portal = await startHttpHost({
        kind: "participant",
        hostname: "127.0.0.1",
        port: 0,
        staticRoot: data,
        service,
      });
    }
    async function request(token: string, body?: unknown, key?: string) {
      if (!portal) throw new Error("Participant host absent");
      const response = await fetch(
        `${portal.origin}/api${body === undefined ? "/portal/me/coordination/projection" : endpoint}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    try {
      const login = await service.admin(
        apiRequest({
          method: "POST",
          path: "/host/bootstrap",
          token: "",
          body: { key: HOST_KEY, ...BENCH_ORGANIZER },
        }),
      );
      const admin = (login.body as { idToken: string }).idToken;
      async function create(name: string) {
        const result = await service.admin(
          apiRequest({
            method: "POST",
            path: "/events",
            token: admin,
            body: {
              name,
              teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
              problems: [{ problemId }],
            },
          }),
        );
        expect(result.status).toBe(201);
        const event = result.body as unknown as CreatedEvent;
        expect(
          (
            await service.admin(
              apiRequest({ method: "POST", path: `/events/${event.eventId}/deploy`, token: admin }),
            )
          ).status,
        ).toBe(202);
        await service.drain();
        expect(
          (
            await service.admin(
              apiRequest({
                method: "PATCH",
                path: `/events/${event.eventId}/schedule`,
                token: admin,
                body: { startNow: true },
              }),
            )
          ).status,
        ).toBe(200);
        return event;
      }
      const own = await create("own match"),
        other = await create("other match");
      const [a, b] = own.teams,
        [foreign] = other.teams;
      if (!a || !b || !foreign) throw new Error("Expected both rosters");
      const teamKey = a.teamLoginKey;
      const job = store.jobs(own.eventId, a.teamId)[0];
      if (!job) throw new Error("Current deployment absent");
      await attach();
      const initial = await request(a.teamLoginKey);
      expect(initial.status).toBe(200);
      const p = initial.body.projection as { revision: number; round: number };
      const op = readyOperation(problemId, p);
      const body = { op, runId: job.jobId };
      const snapshot = () => ({
        own: store.coordination(own.eventId, problemId),
        other: store.coordination(other.eventId, problemId),
        teams: [...store.teams(own.eventId), ...store.teams(other.eventId)],
      });
      const receipt = spyOn(store, "receipt");
      async function rejectRun(runId: unknown, key = nonce) {
        service.flush();
        const before = snapshot(),
          pluginCalls = plugin.mock.calls.length;
        const receiptCalls = receipt.mock.calls.length;
        clock += 10_000;
        const rejected = await request(teamKey, { ...body, runId }, key);
        expect(rejected.status).toBe(409);
        expect(rejected.body.error).toBe("coordination_run_changed");
        expect(plugin.mock.calls.length).toBe(pluginCalls);
        expect(receipt.mock.calls.length).toBe(receiptCalls);
        service.flush();
        expect(snapshot()).toEqual(before);
      }
      for (const runId of [
        store.jobId(own.eventId, b.teamId, problemId),
        store.jobId(other.eventId, foreign.teamId, problemId),
        "missing-run",
        "",
        null,
        42,
      ])
        await rejectRun(runId);
      // Rejections must not reserve the key; the real current-run operation succeeds once.
      const accepted = await request(a.teamLoginKey, body, nonce);
      expect(accepted.status).toBe(200);
      expect(await request(a.teamLoginKey, body, nonce)).toEqual(accepted);
      receipt.mockRestore();
      await portal?.close();
      service.flush();
      store.close();
      store = new HostStore(new Database(database));
      service = new HostingService(store, engine, HOST_KEY, () => clock);
      await service.recover();
      await attach();
      expect(await request(a.teamLoginKey, body, nonce)).toEqual(accepted);
      // Model a retained old Portal request after the persisted deployment ID changes.
      // Only deployment identity changes; the real match and its old receipt stay intact.
      const successor = { ...job, jobId: `successor-${job.jobId}` };
      store.database
        .prepare("UPDATE host_jobs SET id=?,body=? WHERE id=?")
        .run(successor.jobId, JSON.stringify(successor), job.jobId);
      const before = snapshot(),
        pluginCalls = plugin.mock.calls.length;
      const stale = await request(a.teamLoginKey, body, nonce);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe("coordination_run_changed");
      expect(plugin.mock.calls.length).toBe(pluginCalls);
      service.flush();
      expect(snapshot()).toEqual(before);
      // Older clients that omit runId retain their existing operation contract.
      const bView = await request(b.teamLoginKey);
      const bp = bView.body.projection as { revision: number; round: number };
      const legacyOp = readyOperation(problemId, bp);
      expect((await request(b.teamLoginKey, { op: legacyOp })).status).toBe(200);
    } finally {
      plugin.mockRestore();
      await portal?.close();
      await service.drain();
      service.flush();
      store.close();
      rmSync(data, { recursive: true, force: true });
    }
  }, 30_000);
}
