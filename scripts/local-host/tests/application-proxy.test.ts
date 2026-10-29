import { expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { proxyApplication } from "../application-proxy";
import { closeServer, errorResponse, listen } from "../http";
import { HostError, type Job } from "../model";
import { digest } from "../store";

const key = "synthetic-team-access-key";
const cookiePrefix = `tc_app_${digest("job-a").slice(0, 24)}_`;
const initial: Job = {
  jobId: "job-a",
  eventId: "event-a",
  teamId: "team-a",
  problemId: "app",
  offset: 1000,
  status: "COMPLETE",
  unit: "unit-a",
  definition: "definition-a",
  deployedAt: 1,
};

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (fixture: { origin: string; replace: () => void; revoke: () => void }) => Promise<void>,
) {
  let current = initial;
  let authorized = true;
  const upstream = createServer(handler);
  const upstreamOrigin = await listen(upstream, "127.0.0.1", 0);
  let origin = "";
  const gateway = createServer((request, response) => {
    void proxyApplication({
      request,
      response,
      upstream: new URL(upstreamOrigin),
      origin,
      deniedPaths: ["/verify"],
      keyHash: digest(key),
      authorize: () => {
        if (!authorized) throw new HostError(403, "Revoked");
        return current;
      },
    }).catch((error) => errorResponse(response, error));
  });
  origin = await listen(gateway, "127.0.0.1", 0);
  try {
    await run({
      origin,
      replace: () => {
        current = { ...initial, unit: "unit-b" };
      },
      revoke: () => {
        authorized = false;
      },
    });
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
  }
}

test("generic challenge gateway preserves named paths, query, assets, form bodies and application cookies", async () => {
  const seen: { url?: string; authorization?: string; cookie?: string; body: string }[] = [];
  await fixture(
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        seen.push({
          url: request.url,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          body,
        });
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "set-cookie": [
            "challenge_session=accepted; Domain=127.0.0.1; HttpOnly; Path=/",
            "tc_exercise_other=bad; Path=/",
          ],
        });
        response.end(Buffer.from([0, 255, 10]));
      });
    },
    async ({ origin }) => {
      const result = await fetch(`${origin}/nested/app.js?level=2`, {
        headers: {
          authorization: `Bearer ${key}`,
          cookie: `tc_exercise_owner=platform-session; ${cookiePrefix}challenge_session=valid; tc_app_other_challenge_session=must-not-leak; organizer_session=must-not-leak`,
        },
      });
      expect(result.status).toBe(200);
      expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255, 10]);
      expect(result.headers.getSetCookie()).toEqual([
        `${cookiePrefix}challenge_session=accepted; HttpOnly; Path=/`,
      ]);
      expect(seen[0]).toEqual({
        url: "/nested/app.js?level=2",
        authorization: undefined,
        cookie: "challenge_session=valid",
        body: "",
      });
      const sent = await fetch(`${origin}/login`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic synthetic-challenge-login",
        },
        body: "name=competitor",
      });
      expect(sent.status).toBe(200);
      await sent.arrayBuffer();
      expect(seen[1]).toMatchObject({
        url: "/login",
        authorization: "Basic synthetic-challenge-login",
        body: "name=competitor",
      });
    },
  );
});

test("generic challenge gateway blocks private verifier aliases and cross-origin writes before forwarding", async () => {
  let calls = 0;
  await fixture(
    (_request, response) => {
      calls++;
      response.end("unexpected");
    },
    async ({ origin }) => {
      for (const path of [
        "/verify",
        "/verify/child",
        "/VERIFY",
        "/%76erify",
        "/%2576erify",
        "/x/%2e%2e/verify",
        "/%2fverify",
      ]) {
        const result = await fetch(`${origin}${path}`);
        expect(result.status).toBe(404);
        await result.text();
      }
      for (const suppliedOrigin of [undefined, "https://different.invalid"]) {
        const result = await fetch(`${origin}/change`, {
          method: "POST",
          headers: suppliedOrigin ? { origin: suppliedOrigin } : {},
          body: "mutation",
        });
        expect(result.status).toBe(403);
        await result.text();
      }
      expect(calls).toBe(0);
    },
  );
});

test("generic challenge redirects remain at the owned origin and never follow external destinations", async () => {
  await fixture(
    (request, response) => {
      response.writeHead(302, {
        location:
          request.url === "/external" ? "https://unrelated.invalid/secret" : "/account?next=1",
      });
      response.end();
    },
    async ({ origin }) => {
      const local = await fetch(`${origin}/local`, { redirect: "manual" });
      expect(local.status).toBe(302);
      expect(local.headers.get("location")).toBe(`${origin}/account?next=1`);
      await local.text();
      const external = await fetch(`${origin}/external`, { redirect: "manual" });
      expect(external.status).toBe(502);
      expect(external.headers.get("location")).toBeNull();
      await external.text();
    },
  );
});

test("generic challenge gateway caps requests and responses and discards revoked or replaced in-flight output", async () => {
  let calls = 0;
  await fixture(
    (_request, response) => {
      calls++;
      response.end("a".repeat(2 * 1024 * 1024 + 1));
    },
    async ({ origin }) => {
      const oversizedRequest = await fetch(origin, {
        method: "POST",
        // Do not leave Bun's rejected, still-uploading body in its keep-alive
        // pool before the independent response-size check. All server limits
        // and forwarding/authorization assertions below remain unchanged.
        headers: { origin, connection: "close" },
        body: "x".repeat(2 * 1024 * 1024 + 1),
      });
      expect(oversizedRequest.status).toBe(413);
      expect(oversizedRequest.headers.get("connection")).toBe("close");
      await oversizedRequest.text();
      expect(calls).toBe(0);
      const oversizedResponse = await fetch(origin);
      expect(oversizedResponse.status).toBe(502);
      await oversizedResponse.text();
    },
  );
  for (const action of ["replace", "revoke"] as const) {
    let change: () => void = () => {
      throw new Error("Expected initialized mutation");
    };
    await fixture(
      (_request, response) => {
        change();
        response.end("must-not-leak");
      },
      async (f) => {
        change = f[action];
        const response = await fetch(f.origin);
        expect(response.status).toBe(action === "replace" ? 409 : 403);
        expect(await response.text()).not.toContain("must-not-leak");
      },
    );
  }
});

test("a range request reaches the service as a full request, so a 206 never loses its byte interval", async () => {
  const seen: (string | undefined)[] = [];
  await fixture(
    (request, response) => {
      seen.push(request.headers.range);
      if (request.headers.range === "bytes=0-3") {
        response.writeHead(206, { "content-range": "bytes 0-3/10", "accept-ranges": "bytes" });
        response.end("0123");
      } else response.end("0123456789");
    },
    async ({ origin }) => {
      const response = await fetch(`${origin}/document.pdf`, { headers: { range: "bytes=0-3" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("accept-ranges")).toBeNull();
      expect(await response.text()).toBe("0123456789");
    },
  );
  expect(seen).toEqual([undefined]);
});

test("generic challenge gateway forwards challenge X-* headers but keeps TenkaCloud and proxy headers", async () => {
  const seen: IncomingMessage["headers"][] = [];
  await fixture(
    (request, response) => {
      seen.push(request.headers);
      response.end("ok");
    },
    async ({ origin }) => {
      const result = await fetch(`${origin}/api/ops/whoami`, {
        headers: {
          "x-ops-key": "SSOPS-synthetic",
          "X-Break-Glass": "synthetic-break-glass",
          authorization: `Bearer ${key}`,
          cookie: "organizer_session=must-not-leak",
          "x-tenkacloud-capability": "must-not-leak",
          "x-forwarded-host": "spoofed.invalid",
          "x-real-ip": "203.0.113.9",
          "x-original-url": "/verify",
          "x-http-method-override": "DELETE",
        },
      });
      expect(result.status).toBe(200);
      await result.text();
      const headers = seen[0];
      expect(headers?.["x-ops-key"]).toBe("SSOPS-synthetic");
      expect(headers?.["x-break-glass"]).toBe("synthetic-break-glass");
      expect(headers?.authorization).toBeUndefined();
      expect(headers?.cookie).toBeUndefined();
      expect(headers?.["x-tenkacloud-capability"]).toBeUndefined();
      expect(headers?.["x-forwarded-host"]).toBe(new URL(origin).host);
      expect(headers?.["x-real-ip"]).toBeUndefined();
      expect(headers?.["x-original-url"]).toBeUndefined();
      expect(headers?.["x-http-method-override"]).toBeUndefined();
    },
  );
});
