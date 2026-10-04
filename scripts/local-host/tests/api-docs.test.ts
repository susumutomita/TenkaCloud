import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { localOpenApi } from "../openapi";
import { apiDocsFixture } from "./api-docs-fixture";

const create = {
  name: "Synthetic API rehearsal",
  teams: [{ internalSlug: "test-team" }],
  problems: [{ problemId: "sqli-demo" }],
};
test("Swagger dependency is pinned and install analytics remain disabled and untrusted", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  expect(rootPackage.dependencies["swagger-ui-dist"]).toBe("5.32.3");
  expect(rootPackage.scarfSettings.enabled).toBe(false);
  expect(rootPackage.trustedDependencies).not.toContain("@scarf/scarf");
});
test("curated request schemas match validation boundaries", () => {
  const schema =
    localOpenApi("admin").paths["/events"]?.post?.requestBody?.content["application/json"].schema;
  const validate = new Ajv().compile(schema as object);
  expect(validate(create)).toBe(true);
  expect(validate({ ...create, teams: [] })).toBe(false);
  expect(validate({ ...create, teams: [{ internalSlug: "-team" }] })).toBe(false);
  expect(validate({ ...create, teams: [{ internalSlug: "team-" }] })).toBe(false);
  expect(validate({ ...create, problems: [] })).toBe(false);
});
test("docs and real HTTP lifecycle preserve role, origin, expiry and replay boundaries", async () => {
  const f = await apiDocsFixture();
  const call = (
    role: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    token = "",
    nonce?: string,
  ) =>
    fetch(`${f[role].origin}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(nonce ? { "idempotency-key": nonce } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    for (const role of ["admin", "participant"] as const) {
      const spec = await (await fetch(`${f[role].origin}/openapi.json`)).json();
      expect(spec).toEqual(localOpenApi(role));
      const docs = await fetch(`${f[role].origin}/api-docs`);
      expect(docs.status).toBe(200);
      expect(docs.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect(await docs.text()).not.toContain("https://");
      expect((await fetch(`${f[role].origin}/api-docs/swagger-ui-bundle.js`)).status).toBe(200);
      expect(
        (
          await fetch(`${f[role].origin}/openapi.json`, {
            headers: { origin: f[role === "admin" ? "participant" : "admin"].origin },
          })
        ).status,
      ).toBe(403);
    }
    expect((await call("admin", "/events")).status).toBe(401);
    expect((await call("admin", "/host/login", "POST", { key: "invalid" })).status).toBe(401);
    const login = await call("admin", "/host/login", "POST", { key: f.key });
    expect(login.status).toBe(200);
    const { idToken } = await login.json();
    expect((await call("participant", "/portal/me", "GET", undefined, idToken)).status).toBe(401);
    const created = await call("admin", "/events", "POST", create, idToken);
    expect(created.status).toBe(201);
    const { eventId, teams } = await created.json();
    const teamKey = teams[0].teamLoginKey;
    expect((await call("admin", "/events", "GET", undefined, teamKey)).status).toBe(401);
    expect((await call("participant", "/events", "GET", undefined, teamKey)).status).toBe(404);
    expect((await call("admin", "/portal/me", "GET", undefined, idToken)).status).toBe(404);
    expect((await call("admin", `/events/${eventId}/deploy`, "POST", {}, idToken)).status).toBe(
      202,
    );
    await f.service.drain();
    const ready = await call("admin", `/events/${eventId}`, "GET", undefined, idToken);
    expect((await ready.json()).status).toBe("READY");
    const count = f.store.jobs(eventId).length;
    expect((await call("admin", `/events/${eventId}/deploy`, "POST", {}, idToken)).status).toBe(
      409,
    );
    expect(f.store.jobs(eventId)).toHaveLength(count);
    expect(
      (await call("admin", `/events/${eventId}/schedule`, "PATCH", { startNow: true }, idToken))
        .status,
    ).toBe(200);
    expect((await call("participant", "/portal/me", "GET", undefined, teamKey)).status).toBe(200);
    const submission = { problemId: "sqli-demo", flag: "synthetic-wrong-answer" };
    const first = await call(
      "participant",
      "/portal/me/submit-flag",
      "POST",
      submission,
      teamKey,
      "rehearsal-0001",
    );
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(
      await (
        await call(
          "participant",
          "/portal/me/submit-flag",
          "POST",
          submission,
          teamKey,
          "rehearsal-0001",
        )
      ).json(),
    ).toEqual(result);
    expect(
      (
        await call(
          "participant",
          "/portal/me/submit-flag",
          "POST",
          { ...submission, flag: "changed" },
          teamKey,
          "rehearsal-0001",
        )
      ).status,
    ).toBe(409);
    expect((await call("admin", `/events/${eventId}/end`, "POST", {}, idToken)).status).toBe(200);
    expect(
      (
        await call(
          "participant",
          "/portal/me/submit-flag",
          "POST",
          submission,
          teamKey,
          "rehearsal-0002",
        )
      ).status,
    ).toBe(409);
    expect(
      (await call("participant", "/portal/me/score-events", "GET", undefined, teamKey)).status,
    ).toBe(200);
    f.advance(8 * 3600 * 1000 + 1);
    expect((await call("admin", "/events", "GET", undefined, idToken)).status).toBe(401);
  } finally {
    await f.close();
  }
});
