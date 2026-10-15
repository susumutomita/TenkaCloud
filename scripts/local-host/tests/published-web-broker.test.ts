import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { closeServer, listen } from "../http";
import { HostError } from "../model";
import { PublishedWebBroker } from "../published-web-broker";
import { digest } from "../store";
import { terminalFixture } from "./terminal-fixture";

function callBroker(
  address: URL,
  url: URL,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: address.hostname,
        port: address.port,
        path: url.pathname + url.search,
        method,
        headers: { host: url.host, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += String(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

async function fixture() {
  const f = await terminalFixture();
  const seen: { url?: string; authorization?: string; cookie?: string; body: string }[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        body,
      });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://outside.example/" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "app=ok; Domain=example.test; Path=/; HttpOnly",
      });
      res.end(`published:${body}`);
    });
  });
  const upstreamOrigin = new URL(await listen(upstream, "127.0.0.1", 0));
  let published = true;
  const hooks: { beforeResolve?: () => Promise<void> } = {};
  f.engine.networkSupported = () => true;
  f.engine.networkView = async () => ({ supported: true, declared: [], shared: [] });
  f.engine.publishedWebTarget = async (context, _own, target) => {
    await hooks.beforeResolve?.();
    if (
      !published ||
      context.event.eventId !== f.b.job.eventId ||
      target.teamId !== f.b.team.teamId ||
      target.problemId !== "terminal-lab" ||
      target.serviceId !== "web"
    )
      throw new HostError(404, "Not published");
    return {
      job: f.store.job(f.b.job.jobId),
      address: upstreamOrigin.hostname,
      port: Number(upstreamOrigin.port),
    };
  };
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
  f.service.publicWebRevoke = (teamId) => broker.revokeTeam(teamId);
  const target = { teamId: f.b.team.teamId, problemId: "terminal-lab", serviceId: "web" };
  const issue = (body: unknown = target, token = f.a.team.loginKey) =>
    fetch(`${f.participant.origin}/api/portal/me/problems/terminal-lab/public-web-handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ticket = async () => {
    const response = await issue();
    expect(response.status).toBe(200);
    return new URL(((await response.json()) as { url: string }).url);
  };
  const call = (url: URL, headers: Record<string, string> = {}, method = "GET", body?: string) =>
    callBroker(address, url, headers, method, body);
  const session = async () => {
    const url = await ticket();
    const joined = await call(url);
    expect(joined.status).toBe(200);
    const cookie = joined.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    return { url: new URL("/", url), cookie };
  };
  return {
    ...f,
    broker,
    seen,
    hooks,
    issue,
    ticket,
    call,
    session,
    target,
    withdraw: () => {
      published = false;
    },
    close: async () => {
      await broker.close();
      await closeServer(upstream);
      await f.close();
    },
  };
}

test("authenticated ID-only handoff uses one-use host-bound tickets and separate origin cookies", async () => {
  const f = await fixture();
  try {
    expect((await f.issue(f.target, "invalid")).status).toBe(401);
    expect((await f.issue({ ...f.target, url: "http://localhost/" })).status).toBe(400);
    expect((await f.issue({ ...f.target, serviceId: "db" })).status).toBe(404);
    const url = await f.ticket();
    expect(url.origin).toMatch(/^https:\/\/[a-f0-9]{32}\.labs\.example\.test$/u);
    expect((await f.call(url, { host: "play.example.test" })).status).toBe(401);
    expect((await f.call(url)).status).toBe(401);
    const valid = await f.ticket();
    const joined = await f.call(valid);
    expect(joined.status).toBe(200);
    expect(joined.body).toContain('<meta http-equiv="refresh" content="0; url=/">');
    expect(joined.headers["set-cookie"]?.[0]).toContain("Secure; HttpOnly; SameSite=Lax; Path=/");
    expect((await f.call(valid)).status).toBe(401);
    f.advance(30_001);
    const expired = await f.ticket();
    f.advance(30_001);
    expect((await f.call(expired)).status).toBe(401);
  } finally {
    await f.close();
  }
});

test("established sessions follow only same-origin or direct navigations, not other sites or labs", async () => {
  const f = await fixture();
  try {
    const { url, cookie } = await f.session();
    const navigate = (site: string) =>
      f.call(url, { cookie, "sec-fetch-site": site, "sec-fetch-mode": "navigate" });
    expect((await navigate("cross-site")).status).toBe(403);
    expect((await navigate("same-site")).status).toBe(403);
    expect((await navigate("same-origin")).status).toBe(200);
    expect((await navigate("none")).status).toBe(200);
  } finally {
    await f.close();
  }
});

test("broker pins transport, strips console credentials, rejects cross-origin writes and external redirects", async () => {
  const f = await fixture();
  try {
    const { url, cookie } = await f.session();
    const result = await f.call(url, {
      cookie: `${cookie}; console_session=secret`,
      authorization: `Bearer ${f.a.team.loginKey}`,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("published:");
    expect(f.seen[0]).toEqual({ url: "/", authorization: undefined, cookie: undefined, body: "" });
    expect(result.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(result.headers["set-cookie"]?.[0]).not.toContain("Domain=");
    expect(
      (await f.call(url, { cookie, origin: "https://play.example.test" }, "POST", "bad")).status,
    ).toBe(403);
    expect((await f.call(url, { cookie, origin: url.origin }, "POST", "accepted")).body).toBe(
      "published:accepted",
    );
    expect((await f.call(new URL("/redirect", url), { cookie })).status).toBe(502);
    expect(
      (await f.call(url, { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }))
        .status,
    ).toBe(403);
    expect((await f.call(url, { cookie, host: "different.labs.example.test" })).status).toBe(401);
    f.withdraw();
    expect((await f.call(url, { cookie })).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("key rotation, event lock, environment replacement and logout revoke existing Web sessions", async () => {
  const f = await fixture();
  try {
    const { url, cookie } = await f.session();
    f.store.putEvent({ ...f.event, scoringLocked: true });
    expect((await f.call(url, { cookie })).status).toBe(409);
    f.store.putEvent(f.event);
    f.store.putJob({ ...f.b.job, unit: "replacement" });
    expect((await f.call(url, { cookie })).status).toBe(409);
    f.store.putJob(f.b.job);
    f.store.putTeam({ ...f.a.team, loginKey: "rotated" });
    expect((await f.call(url, { cookie })).status).toBe(401);
    f.store.putTeam(f.a.team);
    const logout = await fetch(`${f.participant.origin}/api/portal/me/public-web/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.a.team.loginKey}` },
    });
    expect(logout.status).toBe(200);
    expect((await f.call(url, { cookie })).status).toBe(401);
    const expired = await f.session();
    f.advance(15 * 60_000 + 1);
    expect((await f.call(expired.url, { cookie: expired.cookie })).status).toBe(401);
  } finally {
    await f.close();
  }
});

test("logout wins against pending asynchronous ticket issuance", async () => {
  const f = await fixture();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    f.hooks.beforeResolve = async () => {
      entered();
      await pending;
    };
    const issuing = f.issue();
    await started;
    f.broker.revokeTeam(f.a.team.teamId);
    release();
    expect((await issuing).status).toBe(401);
  } finally {
    release();
    await f.close();
  }
});
