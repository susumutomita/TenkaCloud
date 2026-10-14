import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadContainerProblem } from "../container/manifest";
import { assertPublicServiceSeparation, normalizePublicServices } from "../network-publication";
import { terminalFixture } from "./terminal-fixture";

test("catalog publication IDs are bounded capabilities, never arbitrary network selectors", () => {
  const declaration = {
    id: "public-web",
    service: "web",
    port: 8080,
    purpose: "Competition Web application",
  };
  expect(normalizePublicServices([declaration])).toEqual([declaration]);
  for (const value of [
    [{ ...declaration, address: "127.0.0.1" }],
    [{ ...declaration, port: 0 }],
    [{ ...declaration, service: "web;command" }],
    [{ ...declaration, purpose: " " }],
    [declaration, declaration],
    Array(9).fill(declaration),
  ])
    expect(() => normalizePublicServices(value)).toThrow();
});
test("catalog cannot publish terminal or verifier services, even on another port", () => {
  const problem = loadContainerProblem(
    fileURLToPath(new URL("../../../problems/challenges/sqli-demo", import.meta.url)),
  );
  const text =
    'services:\n  web: {}\n  terminal: {}\n  verifier:\n    ports: ["127.0.0.1:18081:8081"]\n';
  const declared = {
    ...problem,
    verifyUrl: "http://127.0.0.1:18081/verify",
    terminal: { service: "terminal" },
    publicServices: normalizePublicServices([
      { id: "public", service: "web", port: 8080, purpose: "Public Web" },
    ]),
  };
  expect(() => assertPublicServiceSeparation(declared, text)).not.toThrow();
  for (const networks of ["[front, back]", "{front: {}, back: {}}"])
    expect(() =>
      assertPublicServiceSeparation(
        declared,
        text.replace("web: {}", `web: {networks: ${networks}}`),
      ),
    ).toThrow("exactly one");
  for (const service of ["terminal", "verifier", "unknown"])
    expect(() =>
      assertPublicServiceSeparation(
        {
          ...declared,
          publicServices: normalizePublicServices([
            { id: "public", service, port: 8080, purpose: "Public Web" },
          ]),
        },
        text,
      ),
    ).toThrow("separate");
});
test("real participant auth scopes publication to the current team's fixed problem and rejects selectors", async () => {
  const f = await terminalFixture();
  const calls: { teamId: string; serviceId: string; published: boolean }[] = [];
  f.engine.networkSupported = () => true;
  f.engine.networkView = async () => ({
    supported: true,
    declared: [{ id: "public", purpose: "Public Web", published: false }],
    shared: [],
  });
  f.engine.publishNetworkService = async (context, _problemId, serviceId, published) => {
    calls.push({ teamId: context.team.teamId, serviceId, published });
  };
  const call = async (key: string, body: unknown, query = "") =>
    fetch(`${f.participant.origin}/api/portal/me/problems/terminal-lab/network${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect((await call("invalid", { serviceId: "public", published: true })).status).toBe(401);
    expect(
      (
        await call(f.a.team.loginKey, {
          serviceId: "public",
          published: true,
          teamId: f.b.team.teamId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          f.a.team.loginKey,
          { serviceId: "public", published: true },
          `?jobId=${f.b.job.jobId}`,
        )
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await call(f.a.team.loginKey, { serviceId: "public", published: true })).status).toBe(
      200,
    );
    expect(calls).toEqual([{ teamId: f.a.team.teamId, serviceId: "public", published: true }]);
    f.store.putEvent({ ...f.event, scoringLocked: true });
    expect((await call(f.a.team.loginKey, { serviceId: "public", published: false })).status).toBe(
      409,
    );
    expect(calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
