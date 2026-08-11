import { describe, expect, it, vi } from "vitest";
import {
  createNativeCompatibilityGate,
  evaluateNativeCompatibility,
  type HostProbe,
  hasNativeRequirement,
  normalizeArchitecture,
  readHostCapabilities,
} from "../../../scripts/local-play/native-compatibility";
import {
  type LifecycleDeps,
  NativeCompatibilityError,
  ProblemLifecycle,
} from "../../../scripts/local-play/problem-lifecycle";

/**
 * [#3008] The contract these tests hold: a problem whose *result* is only meaningful on a
 * native CPU never starts on a host that cannot produce one, and "we could not tell" is
 * refused rather than assumed compatible. The whole decision is a pure function over
 * injected host facts, so every case here runs without Docker.
 */

const AMD64_ONLY = { nativeArchitectures: ["amd64"] } as const;
const TIMING_FLAGS = {
  nativeArchitectures: ["amd64"],
  cpuFlags: ["rdtscp", "constant_tsc"],
} as const;

describe("normalizeArchitecture (#3008)", () => {
  it("should fold the kernel and Docker spellings of one architecture together", () => {
    expect(normalizeArchitecture("x86_64")).toBe("amd64");
    expect(normalizeArchitecture("amd64")).toBe("amd64");
    expect(normalizeArchitecture("aarch64")).toBe("arm64");
    expect(normalizeArchitecture("arm64")).toBe("arm64");
  });

  it("should ignore surrounding whitespace and case, which docker info output carries", () => {
    expect(normalizeArchitecture("  X86_64\n")).toBe("amd64");
  });

  it("should report an unrecognized name as unknown rather than passing it through", () => {
    // Passing it through would make the comparison answer "unsupported" for a host we
    // simply do not recognize, and those two states need different messages.
    expect(normalizeArchitecture("s390x")).toBeUndefined();
    expect(normalizeArchitecture("")).toBeUndefined();
    expect(normalizeArchitecture(undefined)).toBeUndefined();
  });
});

describe("hasNativeRequirement (#3008)", () => {
  it("should treat an absent, empty or all-empty-array declaration as no requirement", () => {
    expect(hasNativeRequirement(undefined)).toBe(false);
    expect(hasNativeRequirement({})).toBe(false);
    expect(hasNativeRequirement({ nativeArchitectures: [], cpuFlags: [] })).toBe(false);
  });

  it("should recognize a declaration carrying either field", () => {
    expect(hasNativeRequirement({ nativeArchitectures: ["amd64"] })).toBe(true);
    expect(hasNativeRequirement({ cpuFlags: ["rdtscp"] })).toBe(true);
  });
});

describe("evaluateNativeCompatibility (#3008)", () => {
  it("should allow a problem that declares nothing, whatever the host is", () => {
    // Backward compatibility: every problem in the catalog today is this case.
    expect(evaluateNativeCompatibility(undefined, {})).toEqual({ supported: true });
    expect(evaluateNativeCompatibility({}, { architecture: "arm64" })).toEqual({
      supported: true,
    });
  });

  it("should allow a native amd64 host for an amd64 problem", () => {
    expect(evaluateNativeCompatibility(AMD64_ONLY, { architecture: "x86_64" })).toEqual({
      supported: true,
    });
  });

  it("should refuse an arm64 host for an amd64 problem, naming both architectures", () => {
    // The case the mechanism exists for: Docker would happily emulate here.
    const verdict = evaluateNativeCompatibility(AMD64_ONLY, { architecture: "aarch64" });
    expect(verdict.supported).toBe(false);
    if (verdict.supported) throw new Error("unreachable");
    expect(verdict.code).toBe("unsupported_architecture");
    expect(verdict.hostArchitecture).toBe("arm64");
    expect(verdict.requiredArchitectures).toEqual(["amd64"]);
    expect(verdict.message).toMatch(/amd64/);
    expect(verdict.message).toMatch(/arm64/);
    expect(verdict.messageJa).toMatch(/arm64/);
  });

  it("should refuse when the host architecture is unreadable, rather than assume it fits", () => {
    const verdict = evaluateNativeCompatibility(AMD64_ONLY, {});
    expect(verdict.supported).toBe(false);
    if (verdict.supported) throw new Error("unreachable");
    expect(verdict.code).toBe("unknown_host_architecture");
  });

  it("should refuse an architecture it does not recognize as unknown, not as unsupported", () => {
    const verdict = evaluateNativeCompatibility(AMD64_ONLY, { architecture: "s390x" });
    expect(verdict.supported).toBe(false);
    if (verdict.supported) throw new Error("unreachable");
    expect(verdict.code).toBe("unknown_host_architecture");
  });

  it("should allow a host reporting every required CPU flag", () => {
    expect(
      evaluateNativeCompatibility(TIMING_FLAGS, {
        architecture: "amd64",
        cpuFlags: ["fpu", "rdtscp", "constant_tsc", "nonstop_tsc"],
      }),
    ).toEqual({ supported: true });
  });

  it("should name exactly the missing flags, not the whole requirement", () => {
    const verdict = evaluateNativeCompatibility(TIMING_FLAGS, {
      architecture: "amd64",
      cpuFlags: ["fpu", "rdtscp"],
    });
    expect(verdict.supported).toBe(false);
    if (verdict.supported) throw new Error("unreachable");
    expect(verdict.code).toBe("missing_cpu_flags");
    expect(verdict.missingCpuFlags).toEqual(["constant_tsc"]);
    expect(verdict.message).toMatch(/constant_tsc/);
    expect(verdict.message).not.toMatch(/rdtscp/);
  });

  it("should compare flags case-insensitively, since /proc and metadata disagree", () => {
    expect(
      evaluateNativeCompatibility(
        { cpuFlags: ["RDTSCP"] },
        { architecture: "amd64", cpuFlags: ["rdtscp"] },
      ),
    ).toEqual({ supported: true });
  });

  it("should distinguish unreadable CPU flags from a CPU that reports none", () => {
    // Undefined = could not read; [] = read it and there were none. Collapsing them would
    // turn a probe outage into a confident verdict.
    const unreadable = evaluateNativeCompatibility(TIMING_FLAGS, { architecture: "amd64" });
    expect(unreadable.supported).toBe(false);
    if (unreadable.supported) throw new Error("unreachable");
    expect(unreadable.code).toBe("unknown_cpu_flags");

    const none = evaluateNativeCompatibility(TIMING_FLAGS, {
      architecture: "amd64",
      cpuFlags: [],
    });
    expect(none.supported).toBe(false);
    if (none.supported) throw new Error("unreachable");
    expect(none.code).toBe("missing_cpu_flags");
  });

  it("should check the architecture before the flags, so the actionable reason comes first", () => {
    // On an arm64 Mac the x86 flags are missing *because* the architecture is wrong;
    // reporting the flags would send the participant chasing the wrong thing.
    const verdict = evaluateNativeCompatibility(TIMING_FLAGS, {
      architecture: "arm64",
      cpuFlags: [],
    });
    expect(verdict.supported).toBe(false);
    if (verdict.supported) throw new Error("unreachable");
    expect(verdict.code).toBe("unsupported_architecture");
  });
});

describe("readHostCapabilities (#3008)", () => {
  const probe = (over: Partial<HostProbe> = {}): HostProbe => ({
    capture: () => undefined,
    readFile: () => undefined,
    ...over,
  });

  it("should ask the Docker engine for its host architecture, not this process", () => {
    // The requirement, not a detail: `uname` inside a linux/amd64 container on an arm64
    // Mac answers x86_64 because the emulator says so, which is the very state we refuse.
    const capture = vi.fn(() => "aarch64\n");
    expect(readHostCapabilities(probe({ capture })).architecture).toBe("aarch64");
    expect(capture).toHaveBeenCalledWith("docker", ["info", "--format", "{{.Architecture}}"]);
  });

  it("should report an unavailable daemon as unknown architecture", () => {
    expect(readHostCapabilities(probe()).architecture).toBeUndefined();
  });

  it("should report empty docker output as unknown rather than as an empty name", () => {
    expect(readHostCapabilities(probe({ capture: () => "  \n" })).architecture).toBeUndefined();
  });

  it("should read x86 CPU flags from the flags line", () => {
    const cpuinfo = ["processor\t: 0", "flags\t\t: fpu vme RDTSCP constant_tsc", ""].join("\n");
    expect(readHostCapabilities(probe({ readFile: () => cpuinfo })).cpuFlags).toEqual([
      "fpu",
      "vme",
      "rdtscp",
      "constant_tsc",
    ]);
  });

  it("should read arm64 CPU flags from the Features line", () => {
    const cpuinfo = ["processor\t: 0", "Features\t: fp asimd", ""].join("\n");
    expect(readHostCapabilities(probe({ readFile: () => cpuinfo })).cpuFlags).toEqual([
      "fp",
      "asimd",
    ]);
  });

  it("should report unreadable cpuinfo as unknown flags, not as an empty flag set", () => {
    expect(readHostCapabilities(probe()).cpuFlags).toBeUndefined();
    expect(
      readHostCapabilities(probe({ readFile: () => "processor: 0\n" })).cpuFlags,
    ).toBeUndefined();
  });
});

describe("createNativeCompatibilityGate (#3008)", () => {
  it("should not probe the host for a catalog where nothing declares a requirement", () => {
    // Most sessions are this case; they must not pay for a `docker info` subprocess.
    const readHost = vi.fn(() => ({ architecture: "amd64" }));
    const gate = createNativeCompatibilityGate(() => undefined, readHost);
    expect(gate("sqli-demo")).toEqual({ supported: true });
    expect(readHost).not.toHaveBeenCalled();
  });

  it("should probe the host once and reuse it across problems", () => {
    // The daemon's host cannot change while it is up, and start is meant to be cheap.
    const readHost = vi.fn(() => ({ architecture: "arm64" }));
    const gate = createNativeCompatibilityGate(() => AMD64_ONLY, readHost);
    expect(gate("a").supported).toBe(false);
    expect(gate("b").supported).toBe(false);
    expect(readHost).toHaveBeenCalledTimes(1);
  });
});

describe("ProblemLifecycle: native compatibility gate (#3008)", () => {
  function makeDeps(over: Partial<LifecycleDeps> = {}) {
    const started: Array<[string, number]> = [];
    const deps: LifecycleDeps = {
      startContainer: vi.fn(async (id: string, offset: number) => {
        started.push([id, offset]);
      }),
      stopContainer: vi.fn(async () => undefined),
      now: () => 1000,
      ...over,
    };
    return { deps, started };
  }

  const refusal = {
    supported: false,
    code: "unsupported_architecture",
    message: "needs amd64",
    messageJa: "amd64 が必要",
  } as const;

  it("should refuse to start an incompatible problem and never touch a container", async () => {
    const { deps, started } = makeDeps({ nativeCompatibility: () => refusal });
    const lc = new ProblemLifecycle(["asm"], deps, { maxRunning: 2 });
    await expect(lc.ensureRunning("asm")).rejects.toBeInstanceOf(NativeCompatibilityError);
    expect(started).toEqual([]);
  });

  it("should leave the problem stopped, so no cleanup is owed after a refusal", async () => {
    // Acceptance criterion: no partial container / network / volume remains. The lifecycle
    // records ownership only once a start begins, so refusing earlier is what guarantees it.
    const { deps } = makeDeps({ nativeCompatibility: () => refusal });
    const lc = new ProblemLifecycle(["asm"], deps, { maxRunning: 2 });
    await expect(lc.ensureRunning("asm")).rejects.toThrow();
    expect(lc.snapshot()).toEqual([{ problemId: "asm", status: "stopped" }]);
  });

  it("should keep the port slot free, so a refusal costs no capacity", async () => {
    const { deps, started } = makeDeps({
      nativeCompatibility: (id) => (id === "asm" ? refusal : { supported: true }),
    });
    const lc = new ProblemLifecycle(["asm", "sqli"], deps, { maxRunning: 1 });
    await expect(lc.ensureRunning("asm")).rejects.toThrow();
    // With maxRunning 1, a leaked offset would make this second start evict or fail.
    await lc.ensureRunning("sqli");
    expect(started).toEqual([["sqli", 0]]);
  });

  it("should refuse to adopt an incompatible container after restart (#3016)", () => {
    const { deps } = makeDeps({ nativeCompatibility: () => refusal });
    expect(
      () =>
        new ProblemLifecycle(["asm"], deps, {
          maxRunning: 1,
          initialRunning: [{ problemId: "asm", offset: 0 }],
        }),
    ).toThrow(NativeCompatibilityError);
  });

  it("should carry the structured refusal so the CLI and portal render the same facts", async () => {
    const { deps } = makeDeps({ nativeCompatibility: () => refusal });
    const lc = new ProblemLifecycle(["asm"], deps, { maxRunning: 2 });
    await expect(lc.ensureRunning("asm")).rejects.toMatchObject({
      name: "NativeCompatibilityError",
      problemId: "asm",
      refusal: { code: "unsupported_architecture" },
    });
  });

  it("should start a compatible problem normally", async () => {
    const { deps, started } = makeDeps({ nativeCompatibility: () => ({ supported: true }) });
    const lc = new ProblemLifecycle(["asm"], deps, { maxRunning: 2 });
    await expect(lc.ensureRunning("asm")).resolves.toBe(0);
    expect(started).toEqual([["asm", 0]]);
  });

  it("should behave exactly as before when no gate is wired at all", async () => {
    const { deps, started } = makeDeps();
    const lc = new ProblemLifecycle(["sqli"], deps, { maxRunning: 2 });
    await expect(lc.ensureRunning("sqli")).resolves.toBe(0);
    expect(started).toEqual([["sqli", 0]]);
  });

  it("should refuse a problem that is already running once its host stops qualifying", async () => {
    // A problem can reach `running` and only then have a requirement declared (catalog
    // update) — the stale running container must not become a way past the gate.
    let verdict: ReturnType<NonNullable<LifecycleDeps["nativeCompatibility"]>> = {
      supported: true,
    };
    const { deps } = makeDeps({ nativeCompatibility: () => verdict });
    const lc = new ProblemLifecycle(["asm"], deps, { maxRunning: 2 });
    await lc.ensureRunning("asm");
    verdict = refusal;
    await expect(lc.ensureRunning("asm")).rejects.toBeInstanceOf(NativeCompatibilityError);
  });
});
