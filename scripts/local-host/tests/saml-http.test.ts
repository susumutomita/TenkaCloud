import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomToken } from "../auth";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";
import { TestSamlIdP } from "./saml-idp-fixture";

interface Body {
  idToken: string;
  user: { id: string };
  url: string;
  message: string;
}
test("HTTP SAML uses cross-site signed ACS only, browser-bound completion and current organizer permissions", async () => {
  const idp = new TestSamlIdP();
  const store = new HostStore(new Database(":memory:"));
  const errors: unknown[] = [];
  const service = new HostingService(
    store,
    new ExerciseFixture((path) => new Database(path)),
    "test-only-host-key",
  );
  let host: HttpHost | undefined;
  let portal: HttpHost | undefined;
  try {
    host = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: idp.directory,
      service,
      log: (error) => errors.push(error),
    });
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: idp.directory,
      service,
      log: (error) => errors.push(error),
    });
    const origin = host.origin;
    const api = async (path: string, method = "GET", body?: unknown, token = "") => {
      const result = await fetch(`${origin}/api${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: result.status, body: (await result.json()) as Body };
    };
    const bootstrap = await api("/host/bootstrap", "POST", {
      key: "test-only-host-key",
      username: "local-admin",
      password: randomToken(),
    });
    expect(bootstrap.status).toBe(201);
    const admin = bootstrap.body.idToken;
    expect(
      (await api("/feature-flags", "PUT", { key: "audit", enabled: true }, admin)).status,
    ).toBe(200);
    const viewer = await api(
      "/host/users",
      "POST",
      { username: "viewer", password: randomToken(), role: "Viewer" },
      admin,
    );
    expect(viewer.status).toBe(201);
    expect(
      (
        await api(
          "/host/saml/provider",
          "PUT",
          {
            issuer: idp.issuer,
            entryPoint: "https://idp.example.test/login",
            certificate: idp.certificate,
          },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          "/host/saml/identities",
          "POST",
          { userId: viewer.body.user.id, subject: "stable-subject-123" },
          admin,
        )
      ).status,
    ).toBe(201);
    expect((await api("/feature-flags", "PUT", { key: "saml", enabled: true }, admin)).status).toBe(
      200,
    );
    const browserProof = randomToken();
    const start = await api("/host/saml/start", "POST", { browserProof });
    expect(start.status).toBe(200);
    const request = idp.request(start.body.url);
    const signed = idp.response(request);
    const form = new URLSearchParams({ SAMLResponse: signed, RelayState: request.relay });
    const acs = await fetch(request.callback, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: "https://idp.example.test",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(acs.status).toBe(303);
    expect(await acs.text()).toBe("");
    expect(acs.headers.get("referrer-policy")).toBe("no-referrer");
    const redirect = new URL(acs.headers.get("location") ?? "", origin);
    expect(redirect.origin).toBe(origin);
    expect(redirect.pathname).toBe("/login");
    const ticket = new URLSearchParams(redirect.hash.slice(1)).get("samlTicket");
    expect(ticket).toBeTruthy();
    expect(
      (await api("/host/saml/complete", "POST", { ticket, browserProof: randomToken() })).status,
    ).toBe(401);
    const complete = await api("/host/saml/complete", "POST", { ticket, browserProof });
    expect(complete.status).toBe(200);
    const saml = complete.body.idToken;
    expect(
      service.audit
        .list(new URLSearchParams({ action: "organizer.login" }))
        .items.some(
          (item) =>
            item.actor === viewer.body.user.id &&
            item.authMethod === "saml" &&
            item.outcome === "succeeded",
        ),
    ).toBe(true);
    expect((await api("/host/me", "GET", undefined, saml)).body).toMatchObject({
      role: "Viewer",
      authMethod: "saml",
    });
    expect((await api("/host/saml/provider", "GET", undefined, saml)).status).toBe(403);
    expect(
      (
        await api(
          "/host/users",
          "POST",
          { username: "attacker", password: randomToken(), role: "Admin" },
          saml,
        )
      ).status,
    ).toBe(403);
    expect((await fetch(`${portal.origin}/api/host/saml`)).status).toBe(404);
    const ordinary = await fetch(`${origin}/api/host/saml/start`, {
      method: "POST",
      headers: {
        origin: "https://idp.example.test",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ browserProof }),
    });
    expect(ordinary.status).toBe(403);
    expect(
      (await api("/feature-flags", "PUT", { key: "saml", enabled: false }, admin)).status,
    ).toBe(200);
    expect((await api("/host/me", "GET", undefined, saml)).status).toBe(401);
    expect((await api("/host/me", "GET", undefined, admin)).status).toBe(200);
    expect((await api("/feature-flags", "PUT", { key: "saml", enabled: true }, admin)).status).toBe(
      200,
    );
    expect((await api("/host/me", "GET", undefined, saml)).status).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await portal?.close();
    await host?.close();
    await service.drain();
    store.close();
    idp.close();
  }
});
