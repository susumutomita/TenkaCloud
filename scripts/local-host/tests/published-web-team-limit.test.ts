import { expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, request, type ServerResponse } from "node:http";
import { closeServer, listen } from "../http";
import { PublishedWebBroker } from "../published-web-broker";
import { digest } from "../store";
import { terminalFixture } from "./terminal-fixture";

function callBroker(address: URL, url: URL, cookie: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: address.hostname,
        port: address.port,
        path: url.pathname + url.search,
        headers: { host: url.host, cookie },
      },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(5);
  }
}

async function fixture() {
  const f = await terminalFixture();
  const held: ServerResponse[] = [];
  const upstream = createServer((incoming, response) => {
    incoming.resume();
    if (incoming.url === "/slow") held.push(response);
    else response.end("fast");
  });
  const upstreamOrigin = new URL(await listen(upstream, "127.0.0.1", 0));
  f.engine.networkSupported = () => true;
  f.engine.networkView = async () => ({ supported: true, declared: [], shared: [] });
  f.engine.publishedWebTarget = async () => ({
    job: f.store.job(f.b.job.jobId),
    address: upstreamOrigin.hostname,
    port: Number(upstreamOrigin.port),
  });
  const broker = new PublishedWebBroker(f.service, {
    consoleOrigin: "https://play.example.test",
    webOriginTemplate: "https://{target}.labs.example.test",
    webPort: 0,
    behindProxy: true,
    webServiceIds: ["web"],
  });
  const address = new URL(await broker.listen());
  f.service.publicWebHandoff = (team, own, target) =>
    broker.issue(team.teamId, digest(team.loginKey), own, target);
  const session = async (loginKey: string) => {
    const issued = await fetch(
      `${f.participant.origin}/api/portal/me/problems/terminal-lab/public-web-handoff`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${loginKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          teamId: f.b.team.teamId,
          problemId: "terminal-lab",
          serviceId: "web",
        }),
      },
    );
    expect(issued.status).toBe(200);
    const ticket = new URL(((await issued.json()) as { url: string }).url);
    const joined = await callBroker(address, ticket, "");
    expect(joined.status).toBe(303);
    const cookie = joined.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    return (path: string) => callBroker(address, new URL(path, ticket), cookie);
  };
  return {
    ...f,
    held,
    session,
    release: () => {
      for (const response of held.splice(0)) response.end("slow");
    },
    close: async () => {
      for (const response of held.splice(0)) response.destroy();
      await broker.close();
      await closeServer(upstream);
      await f.close();
    },
  };
}

test("one team holding slow Web requests cannot take the broker capacity of another team", async () => {
  const f = await fixture();
  try {
    const alpha = await f.session(f.a.team.loginKey);
    const beta = await f.session(f.b.team.loginKey);
    const statuses: number[] = [];
    const flood = Array.from({ length: 64 }, () =>
      alpha("/slow").then(({ status }) => {
        statuses.push(status);
      }),
    );
    await until(() => f.held.length + statuses.length === 64, "every flood request to settle");

    expect((await beta("/")).status).toBe(200);
    expect({ heldUpstream: f.held.length, rejected: statuses }).toEqual({
      heldUpstream: 16,
      rejected: Array.from({ length: 48 }, () => 429),
    });

    f.release();
    await Promise.all(flood);
    expect(statuses.filter((status) => status === 200)).toHaveLength(16);
    expect((await alpha("/")).status).toBe(200);
  } finally {
    await f.close();
  }
});
