import { describe, expect, it } from "vitest";
import type { CommandOutcome, CommandRunner } from "../../../scripts/onboard/diagnose";
import {
  collectPreflightFacts,
  currentPlatform,
  parseProfileFlag,
  resolveCommand,
} from "../../../scripts/tenkacloud-onboard";

/**
 * [Issue #2696 PR 2] currentPlatform() used to read process.platform directly,
 * so it could not be unit-tested. It now takes an injectable platform argument
 * (default process.platform), matching the injectability pattern already used by
 * diagnose()/plan() elsewhere in the onboarding CLI.
 */
describe("currentPlatform", () => {
  it("should map darwin to the darwin platform", () => {
    expect(currentPlatform("darwin")).toBe("darwin");
  });

  it("should map linux to the linux platform", () => {
    expect(currentPlatform("linux")).toBe("linux");
  });

  it("should map win32 (native Windows) to other", () => {
    expect(currentPlatform("win32")).toBe("other");
  });

  it("should map freebsd (BSD) to other", () => {
    expect(currentPlatform("freebsd")).toBe("other");
  });

  it("should default to reading process.platform when no argument is given", () => {
    expect(currentPlatform()).toBe(currentPlatform(process.platform));
  });
});

/**
 * [Issue #2909] `tenkacloud doctor --profile <id> [--probe-disk]`. Two behaviours
 * matter beyond plain parsing: a mistyped profile must fail rather than silently
 * report a different profile's numbers, and the disk probe (which pulls busybox)
 * must not run unless it was asked for — `doctor` is documented as leaving the
 * machine unchanged.
 */
describe("parseProfileFlag", () => {
  it("should return undefined when --profile was not passed", () => {
    expect(parseProfileFlag(["doctor"])).toBeUndefined();
  });

  it.each(["minimum", "recommended", "full"])("should accept the %s profile", (id) => {
    expect(parseProfileFlag(["doctor", "--profile", id])).toBe(id);
  });

  it("should reject an unknown profile instead of falling back to the default", () => {
    expect(() => parseProfileFlag(["doctor", "--profile", "tiny"])).toThrow(/Unknown profile/);
  });

  it("should reject --profile with no value, including a following flag", () => {
    expect(() => parseProfileFlag(["doctor", "--profile"])).toThrow(/needs a value/);
    expect(() => parseProfileFlag(["--profile", "--probe-disk"])).toThrow(/needs a value/);
  });
});

describe("resolveCommand", () => {
  it("should default to doctor when no subcommand was given", () => {
    expect(resolveCommand([])).toBe("doctor");
    expect(resolveCommand(["--yes"])).toBe("doctor");
  });

  it("should read an explicit subcommand", () => {
    expect(resolveCommand(["preflight", "--yes"])).toBe("preflight");
  });

  it("should not mistake --profile's value for the subcommand", () => {
    expect(resolveCommand(["--profile", "recommended"])).toBe("doctor");
    expect(resolveCommand(["--profile", "recommended", "preflight"])).toBe("preflight");
  });
});

describe("collectPreflightFacts", () => {
  function runnerFor(outcomes: Record<string, CommandOutcome>): {
    runner: CommandRunner;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      runner: {
        run(command, args) {
          const key = [command, ...args].join(" ");
          calls.push(key);
          const match = Object.entries(outcomes).find(([prefix]) => key.startsWith(prefix));
          return match?.[1] ?? { code: 1, stdout: "", stderr: "" };
        },
      },
    };
  }

  const info = { code: 0, stdout: "4\t4090956349\t29.6.1\tUbuntu\taarch64", stderr: "" };
  const df = {
    code: 0,
    stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1 2 42513524 27% /",
    stderr: "",
  };

  it("should read Docker's CPU and memory without probing the disk by default", () => {
    const { runner, calls } = runnerFor({ "docker info": info });

    const facts = collectPreflightFacts(runner, false);

    expect(facts.dockerCpus).toBe(4);
    expect(facts.dockerMemoryBytes).toBe(4090956349);
    expect(facts.freeDiskBytes).toBeUndefined();
    expect(calls.some((call) => call.includes("busybox"))).toBe(false);
  });

  it("should probe free disk only when asked", () => {
    const { runner, calls } = runnerFor({ "docker info": info, "docker run --rm busybox": df });

    const facts = collectPreflightFacts(runner, true);

    expect(facts.freeDiskBytes).toBe(42513524 * 1024);
    expect(calls.some((call) => call.includes("busybox"))).toBe(true);
  });

  it("should leave free disk unknown when the probe fails rather than reporting zero", () => {
    const { runner } = runnerFor({ "docker info": info });

    expect(collectPreflightFacts(runner, true).freeDiskBytes).toBeUndefined();
  });

  it("should leave every fact unknown when the daemon is down", () => {
    const { runner } = runnerFor({ "docker info": { code: 1, stdout: "0\t0\t\t\t", stderr: "" } });

    expect(collectPreflightFacts(runner, true)).toEqual({
      dockerCpus: undefined,
      dockerMemoryBytes: undefined,
      freeDiskBytes: undefined,
    });
  });
});
