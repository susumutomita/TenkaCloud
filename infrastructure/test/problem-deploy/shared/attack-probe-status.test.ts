import { describe, expect, it } from "vitest";
import {
  parseAttackProbeStatus,
  serializeAttackProbeStatus,
} from "../../../lib/problem-deploy/handlers/shared/attack-probe-status";

/**
 * [#2422] uptime-multi の attack-probe snapshot の parse / serialize。 scoring engine が書き、
 * participant-handler が読む DDB `attackProbes` 列の shape を fail-safe に守る。
 */
describe("parseAttackProbeStatus", () => {
  it("should round-trip a serialized snapshot", () => {
    const status = {
      checkedAt: "2026-07-07T00:00:00.000Z",
      probes: [
        { outcome: "landed" as const, penalty: 60, label: "Auth bypass", symptom: "accepts login" },
        { outcome: "blocked" as const, penalty: 30 },
      ],
    };
    expect(parseAttackProbeStatus(serializeAttackProbeStatus(status))).toEqual(status);
  });

  it("should return undefined for absent / empty / non-JSON input", () => {
    expect(parseAttackProbeStatus(undefined)).toBeUndefined();
    expect(parseAttackProbeStatus("")).toBeUndefined();
    expect(parseAttackProbeStatus("not-json{")).toBeUndefined();
  });

  it("should return undefined for a non-object or array payload", () => {
    expect(parseAttackProbeStatus("42")).toBeUndefined();
    expect(parseAttackProbeStatus("null")).toBeUndefined();
    expect(parseAttackProbeStatus("[1,2,3]")).toBeUndefined();
  });

  it("should return undefined when probes is missing or not an array", () => {
    expect(parseAttackProbeStatus(JSON.stringify({ checkedAt: "x" }))).toBeUndefined();
    expect(parseAttackProbeStatus(JSON.stringify({ probes: "nope" }))).toBeUndefined();
  });

  it("should drop malformed probe entries and keep valid ones", () => {
    const raw = JSON.stringify({
      checkedAt: "2026-07-07T00:00:00.000Z",
      probes: [
        null,
        "string",
        { outcome: "unknown", penalty: 10 }, // invalid outcome
        { outcome: "landed", penalty: "x" }, // non-number penalty
        { outcome: "landed", penalty: Number.NaN }, // non-finite penalty
        { outcome: "landed", penalty: 60 }, // valid
      ],
    });
    const parsed = parseAttackProbeStatus(raw);
    expect(parsed?.probes).toEqual([{ outcome: "landed", penalty: 60 }]);
  });

  it("should return undefined when every probe entry is invalid", () => {
    const raw = JSON.stringify({ probes: [{ outcome: "bogus", penalty: 1 }] });
    expect(parseAttackProbeStatus(raw)).toBeUndefined();
  });

  it("should omit checkedAt when it is absent or blank, and blank label/symptom", () => {
    const raw = JSON.stringify({
      checkedAt: "",
      probes: [{ outcome: "blocked", penalty: 5, label: "", symptom: "" }],
    });
    expect(parseAttackProbeStatus(raw)).toEqual({ probes: [{ outcome: "blocked", penalty: 5 }] });
  });
});
