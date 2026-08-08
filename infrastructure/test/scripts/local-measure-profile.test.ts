import { describe, expect, it } from "vitest";
import {
  buildRecord,
  buildRecordId,
  envValue,
  leakedContainers,
  preexistingProblemContainers,
  requireProblemIds,
  resolvePlatformKey,
} from "../../../scripts/local/measure-profile";
import { findProfile } from "../../../scripts/local/profiles";

/**
 * [Issue #2909] The benchmark's decision logic, tested without Docker: which
 * platform bucket a run belongs to, how unread values reach the record, and the
 * reclaim check that decides whether a run is publishable at all.
 */

const BASE_INPUT = {
  capturedAt: "2026-08-08T00:00:00.000Z",
  release: "v1.1.0",
  platformKey: "macos-arm64" as const,
  facts: {
    cpus: 4,
    memoryBytes: 4090956349,
    serverVersion: "29.6.1",
    operatingSystem: "Ubuntu 24.04.4 LTS",
    architecture: "aarch64",
  },
  composeVersion: "5.3.1",
  hostDescription: "MacBook Air M5 / 32 GB",
  freeDiskBytes: 42513524 * 1024,
  scenarios: [
    {
      scenario: "control-plane-only",
      profileId: null,
      samples: [{ name: "tenkacloud-local", cpuPercent: 1.2, memBytes: 124780544 }],
    },
    {
      scenario: "minimum",
      profileId: "minimum" as const,
      samples: [
        { name: "tenkacloud-local", cpuPercent: 1.2, memBytes: 124780544 },
        { name: "tc-local-sqli-demo-web-1", cpuPercent: 0.1, memBytes: 17825792 },
      ],
    },
  ],
  timings: [{ id: "start:sqli-demo", phase: "warm" as const, durationMs: 4200 }],
  controlPlaneImageBytes: 755000000,
  unmeasured: ["multi-container problems"],
  notes: ["Problems measured: sqli-demo"],
};

describe("resolvePlatformKey", () => {
  it("should file a Codespaces run under codespaces even though it reports as Linux", () => {
    expect(resolvePlatformKey("linux", "x86_64", { CODESPACES: "true" })).toBe("codespaces");
    expect(resolvePlatformKey("linux", "x86_64", { CODESPACE_NAME: "fluffy-couscous" })).toBe(
      "codespaces",
    );
  });

  it("should file a WSL2 run under wsl2 rather than under plain Linux", () => {
    expect(resolvePlatformKey("linux", "x86_64", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl2");
    expect(resolvePlatformKey("linux", "x86_64", { WSL_INTEROP: "/run/WSL/1" })).toBe("wsl2");
  });

  it("should prefer Codespaces over WSL2 when both markers are somehow present", () => {
    expect(
      resolvePlatformKey("linux", "x86_64", { CODESPACES: "true", WSL_DISTRO_NAME: "Ubuntu" }),
    ).toBe("codespaces");
  });

  it("should split macOS by architecture", () => {
    expect(resolvePlatformKey("darwin", "aarch64", {})).toBe("macos-arm64");
    expect(resolvePlatformKey("darwin", "arm64", {})).toBe("macos-arm64");
    expect(resolvePlatformKey("darwin", "x86_64", {})).toBe("macos-x86_64");
    expect(resolvePlatformKey("darwin", undefined, {})).toBe("macos-x86_64");
  });

  it("should treat anything else as linux-x86_64", () => {
    expect(resolvePlatformKey("linux", "x86_64", {})).toBe("linux-x86_64");
  });
});

describe("buildRecordId", () => {
  it("should combine the capture date, platform and release", () => {
    expect(buildRecordId("2026-08-08T00:04:56Z", "macos-arm64", "v1.1.0")).toBe(
      "2026-08-08-macos-arm64-v1.1.0",
    );
  });

  it("should strip characters that would be awkward in a filename", () => {
    expect(buildRecordId("2026-08-08T00:04:56Z", "wsl2", "feature/x y")).toBe(
      "2026-08-08-wsl2-feature-x-y",
    );
  });
});

describe("buildRecord", () => {
  it("should produce a record that validates against the schema", () => {
    expect(() => buildRecord(BASE_INPUT)).not.toThrow();
  });

  it("should total each scenario's owned containers", () => {
    const record = buildRecord(BASE_INPUT);
    const minimum = record.observations.find((o) => o.profileId === "minimum");

    expect(minimum?.containerCount).toBe(2);
    expect(minimum?.totalMemBytes).toBe(124780544 + 17825792);
    expect(minimum?.containers[0].name).toBe("tenkacloud-local");
  });

  it("should write values the run could not read as null rather than as zero", () => {
    const record = buildRecord({
      ...BASE_INPUT,
      facts: { cpus: 4 },
      composeVersion: undefined,
      hostDescription: undefined,
      freeDiskBytes: undefined,
    });

    expect(record.host.memoryBytes).toBeNull();
    expect(record.host.freeDiskBytes).toBeNull();
    expect(record.host.composeVersion).toBeNull();
    expect(record.host.serverVersion).toBeNull();
    expect(record.host.description).toBeNull();
  });

  it("should omit the image list when the image size could not be read", () => {
    const record = buildRecord({ ...BASE_INPUT, controlPlaneImageBytes: undefined });

    expect(record.images).toEqual([]);
  });

  it("should mark itself as produced by the script and carry the schema version", () => {
    const record = buildRecord(BASE_INPUT);

    expect(record.capturedBy).toBe("measure-profile");
    expect(record.schemaVersion).toBe(1);
    expect(record.recordId).toBe("2026-08-08-macos-arm64-v1.1.0");
  });

  it("should reject a run that measured nothing it can state coverage limits for", () => {
    expect(() => buildRecord({ ...BASE_INPUT, unmeasured: [""] })).toThrow(
      /Invalid measurement record/,
    );
  });
});

describe("leakedContainers", () => {
  const baseline = [{ name: "tenkacloud-local", cpuPercent: 1, memBytes: 10 }];

  it("should report nothing when the run's own containers were reclaimed", () => {
    expect(leakedContainers(baseline, baseline)).toEqual([]);
  });

  it("should name containers that outlived the run", () => {
    const after = [...baseline, { name: "tc-local-sqli-demo-web-1", cpuPercent: 0, memBytes: 1 }];

    expect(leakedContainers(baseline, after)).toEqual(["tc-local-sqli-demo-web-1"]);
  });

  it("should not complain when the baseline itself disappeared", () => {
    // A control plane that stopped is a different failure; this check is only
    // about containers the run created and failed to remove.
    expect(leakedContainers(baseline, [])).toEqual([]);
  });
});

describe("preexistingProblemContainers", () => {
  it("should accept a baseline of the control plane alone", () => {
    expect(
      preexistingProblemContainers([{ name: "tenkacloud-local", cpuPercent: 1, memBytes: 10 }]),
    ).toEqual([]);
  });

  it("should name problem containers that were already up, whose memory would be miscounted", () => {
    expect(
      preexistingProblemContainers([
        { name: "tenkacloud-local", cpuPercent: 1, memBytes: 10 },
        { name: "tc-local-sqli-demo-web-1", cpuPercent: 0, memBytes: 1 },
      ]),
    ).toEqual(["tc-local-sqli-demo-web-1"]);
  });
});

describe("requireProblemIds", () => {
  const minimum = findProfile("minimum");
  const recommended = findProfile("recommended");
  if (!minimum || !recommended) throw new Error("expected both profiles to exist");

  it("should accept exactly as many ids as the profile runs at once", () => {
    expect(requireProblemIds(minimum, "sqli-demo")).toEqual(["sqli-demo"]);
    expect(requireProblemIds(recommended, "a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("should refuse a count that does not match the profile's concurrency", () => {
    expect(() => requireProblemIds(recommended, "a,b")).toThrow(/runs 3 problem\(s\) but 2/);
  });

  it("should ask for the ids when none were given, and name the command that lists them", () => {
    expect(() => requireProblemIds(minimum, undefined)).toThrow(/make local-list/);
    expect(() => requireProblemIds(minimum, " , ")).toThrow(/PROBLEMS is required/);
  });
});

describe("envValue", () => {
  it("should treat make's empty-string pass-through as unset", () => {
    expect(envValue("")).toBeUndefined();
    expect(envValue("   ")).toBeUndefined();
    expect(envValue(undefined)).toBeUndefined();
  });

  it("should trim a real value", () => {
    expect(envValue(" minimum ")).toBe("minimum");
  });
});
