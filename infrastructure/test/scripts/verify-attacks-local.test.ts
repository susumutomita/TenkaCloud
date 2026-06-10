import { describe, expect, it } from "vitest";
import {
  type AttackProbeDecl,
  evaluateProbeOutcome,
  joinUrl,
  readAttackProbes,
  resolveLocalAttackProbes,
  summarizeVerification,
} from "../../../scripts/lib/verify-attacks-local";

/**
 * [Issue #1666] Local attack-verification harness — pure logic pin.
 *
 * Proves the assertion layer that the docker-driven shell relies on: parsing `scoring.attackProbes`,
 * resolving each to a local URL with the scorer's `joinUrl` semantics, judging a fired probe against
 * the live status, and concluding "all declared attacks landed on the vulnerable baseline". The
 * docker run proves the *app*; this proves the *judgement* (CI-safe, no docker).
 */

const SQLI_PROBE: AttackProbeDecl = {
  slot: "api",
  path: "/api/v1/auth",
  method: "POST",
  body: JSON.stringify({ username: "' OR '1'='1' -- ", password: "x" }),
  vulnerableStatus: [200],
  penalty: 50,
};

describe("joinUrl (scorer parity)", () => {
  it("should concat base + path with a single slash", () => {
    expect(joinUrl("http://localhost:18080", "/api/v1/auth")).toBe(
      "http://localhost:18080/api/v1/auth",
    );
  });

  it("should normalize a trailing slash on base and a missing slash on path", () => {
    expect(joinUrl("http://localhost:18080/", "api/v1/auth")).toBe(
      "http://localhost:18080/api/v1/auth",
    );
  });

  it("should let an absolute path override the base", () => {
    expect(joinUrl("http://localhost:18080", "http://evil/x")).toBe("http://evil/x");
  });
});

describe("readAttackProbes (#1666)", () => {
  it("should return the declared attackProbes from metadata", () => {
    const probes = readAttackProbes({
      scoring: { kind: "uptime-multi", attackProbes: [SQLI_PROBE] },
    });
    expect(probes).toHaveLength(1);
    expect(probes[0]?.slot).toBe("api");
    expect(probes[0]?.method).toBe("POST");
  });

  it("should return an empty array when no attackProbes are declared", () => {
    expect(readAttackProbes({ scoring: { kind: "uptime-multi" } })).toEqual([]);
    expect(readAttackProbes({})).toEqual([]);
  });

  it("should throw when attackProbes is not an array", () => {
    expect(() => readAttackProbes({ scoring: { attackProbes: {} } })).toThrow(/must be an array/);
  });

  it("should throw on a probe missing a required field (loud, not silent)", () => {
    expect(() =>
      readAttackProbes({ scoring: { attackProbes: [{ slot: "api", vulnerableStatus: [200] }] } }),
    ).toThrow(/path must be a non-empty string/);
    expect(() =>
      readAttackProbes({
        scoring: { attackProbes: [{ slot: "api", path: "/x", vulnerableStatus: [] }] },
      }),
    ).toThrow(/vulnerableStatus must be a non-empty number/);
  });
});

describe("resolveLocalAttackProbes (#1666)", () => {
  const slotBaseUrls = { api: "http://localhost:18080", frontend: "http://localhost:18081" };

  it("should resolve a probe's slot to its local URL, carrying method + body", () => {
    const [resolved] = resolveLocalAttackProbes([SQLI_PROBE], slotBaseUrls);
    expect(resolved?.url).toBe("http://localhost:18080/api/v1/auth");
    expect(resolved?.method).toBe("POST");
    expect(resolved?.body).toBe(SQLI_PROBE.body);
    expect(resolved?.name).toBe("api POST /api/v1/auth");
  });

  it("should default the method to GET when omitted", () => {
    const [resolved] = resolveLocalAttackProbes(
      [{ slot: "api", path: "/x", vulnerableStatus: [200], penalty: 1 }],
      slotBaseUrls,
    );
    expect(resolved?.method).toBe("GET");
    expect(resolved?.body).toBeUndefined();
  });

  it("should throw on a slot with no local base URL (no silent skip)", () => {
    expect(() =>
      resolveLocalAttackProbes([{ ...SQLI_PROBE, slot: "users" }], slotBaseUrls),
    ).toThrow(/slot 'users' which has no local base URL/);
  });
});

describe("evaluateProbeOutcome + summarizeVerification (#1666)", () => {
  const [resolved] = resolveLocalAttackProbes([SQLI_PROBE], { api: "http://localhost:18080" });
  if (!resolved) throw new Error("fixture: resolveLocalAttackProbes returned no probe");

  it("should mark the probe fired when the live status is in vulnerableStatus", () => {
    const outcome = evaluateProbeOutcome(resolved, 200);
    expect(outcome.fired).toBe(true);
    expect(outcome.actual).toBe(200);
  });

  it("should mark the probe NOT fired when the app rejected the attack (defended)", () => {
    expect(evaluateProbeOutcome(resolved, 403).fired).toBe(false);
  });

  it("should conclude allFired only when every probe landed", () => {
    const allHit = summarizeVerification([
      evaluateProbeOutcome(resolved, 200),
      evaluateProbeOutcome(resolved, 200),
    ]);
    expect(allHit).toEqual({ total: 2, firedCount: 2, allFired: true });

    const oneMissed = summarizeVerification([
      evaluateProbeOutcome(resolved, 200),
      evaluateProbeOutcome(resolved, 403),
    ]);
    expect(oneMissed).toEqual({ total: 2, firedCount: 1, allFired: false });
  });

  it("should not report allFired for an empty outcome set", () => {
    expect(summarizeVerification([])).toEqual({ total: 0, firedCount: 0, allFired: false });
  });
});
