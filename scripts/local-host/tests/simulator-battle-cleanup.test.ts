import { expect, test } from "bun:test";
import { battleOwnerKey, sealBattleBinding } from "../simulator-battle-binding";
import type { OwnedSimulatorClock } from "../simulator-clock-bootstrap";

const owner = {
  eventId: "event",
  teamId: "team",
  jobId: "job",
  unitHash: "a".repeat(64),
  deployedAt: 1000,
  stackId: "stack",
  instanceId: "i-one",
};
function fixture(value: unknown, rejectAuthentication = false) {
  const requests: unknown[] = [];
  let authenticated = 0;
  const domain = `mono-${"a".repeat(32)}`;
  const clock: OwnedSimulatorClock = {
    domain,
    authenticateSample: () => {
      throw new Error("Cleanup must not rebase the clock");
    },
    authenticateResponse: (response) => {
      authenticated++;
      expect(response.path).toBe("/_simulator/v1/battle-capabilities/seal");
      expect(response.domain).toBe(domain);
      expect(JSON.parse(new TextDecoder().decode(response.request))).toEqual({
        version: 1,
        owner,
        key: battleOwnerKey(owner),
      });
      if (rejectAuthentication) throw new Error("Untrusted response");
    },
  };
  return {
    requests,
    authenticated: () => authenticated,
    run: () =>
      sealBattleBinding(
        { endpoint: "http://127.0.0.1:1234", region: "local", readToken: () => "a".repeat(64) },
        clock,
        owner,
        {
          now: () => 1,
          transport: async (url, init) => {
            requests.push({ path: url.pathname, method: init.method });
            return new Response(JSON.stringify(value), {
              headers: {
                "X-Simulator-Clock-Domain": domain,
                "X-Simulator-Clock-MAC": "b".repeat(64),
              },
            });
          },
        },
      ),
  };
}

test("cleanup seals exact retained owner directly and confirms both seal and join", async () => {
  const f = fixture({ sealed: true, joined: true });
  expect(await f.run()).toEqual({ sealed: true, joined: true });
  expect(f.requests).toEqual([{ path: "/_simulator/v1/battle-capabilities/seal", method: "POST" }]);
  expect(f.authenticated()).toBe(1);
});
for (const value of [
  null,
  {},
  { sealed: true, joined: false },
  { sealed: false, joined: true },
  { sealed: true, joined: true, foreign: true },
]) {
  test(`cleanup does not confirm partial or malformed response ${JSON.stringify(value)}`, async () => {
    const f = fixture(value);
    await expect(f.run()).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    expect(f.authenticated()).toBe(1);
  });
}
test("cleanup never accepts an unauthenticated success or retries implicitly", async () => {
  const f = fixture({ sealed: true, joined: true }, true);
  await expect(f.run()).rejects.toThrow("Untrusted response");
  expect(f.requests).toHaveLength(1);
});
