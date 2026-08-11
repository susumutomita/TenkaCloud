/**
 * [#3008] Fail-closed native CPU compatibility for local problems whose *result*, not just
 * their execution, depends on running on a real CPU of a given architecture.
 *
 * The problem this exists for (TenkaCloudChallenge#434): an amd64 instruction-latency
 * benchmark started on Apple Silicon runs happily under QEMU emulation and produces a
 * plausible cycle count that means nothing. Nothing crashes, nothing warns — the
 * participant gets a number and a rank built on a measurement that was never valid.
 * A wrong answer that looks right is worse than a refusal, so a problem may declare what
 * it needs and the platform refuses to start it anywhere else.
 *
 * Deliberate divergence from {@link describePortHolder}, the other pre-start probe in this
 * codebase: that one **fails open** ("a probe outage must not become a refusal to start"),
 * because a missed port conflict costs a confusing compose error and nothing more. This one
 * **fails closed**, because a missed emulation check costs a silently invalid result that
 * the participant cannot tell from a valid one. Same shape, opposite default, on purpose.
 *
 * Scope: this is compatibility *reporting*. Saying a host is supported is not a claim that
 * a benchmark on it is stable or comparable across machines — that is the problem's own
 * job (TenkaCloudChallenge#434 normalizes against a baseline measured on the same host).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * What a problem declares it needs, mirroring `runtime.compatibility` in the catalog
 * schema. Both fields are optional; a problem declaring neither is not using this
 * mechanism at all and must keep its previous behavior.
 */
export interface NativeCompatibilityRequirement {
  /**
   * Architectures on which this problem's result is meaningful, as Docker/OCI platform
   * names (`amd64`, `arm64`, …). The host must natively be one of them — a host that can
   * only *emulate* one is not a match, which is the entire point.
   */
  readonly nativeArchitectures?: readonly string[];
  /** CPU feature flags the measurement depends on, as the host reports them (`rdtscp`, …). */
  readonly cpuFlags?: readonly string[];
}

/**
 * What we managed to learn about the machine that will actually execute the containers.
 *
 * Every field is optional and absence is *not* "no requirement" — it is "unknown", which
 * fails closed. This is why the type does not default anything: a default here would be a
 * guess presented as a fact.
 */
export interface HostCapabilities {
  /** Normalized architecture of the Docker engine's host, or undefined if unreadable. */
  readonly architecture?: string;
  /** CPU flags read from the host, or undefined if they could not be read at all. */
  readonly cpuFlags?: readonly string[];
}

export type NativeCompatibilityCode =
  | "unknown_host_architecture"
  | "unsupported_architecture"
  | "unknown_cpu_flags"
  | "missing_cpu_flags";

/** Refusal detail, kept structured so the CLI and the portal render the same facts. */
export interface NativeCompatibilityRefusal {
  readonly supported: false;
  readonly code: NativeCompatibilityCode;
  /** Architectures the problem accepts (present for architecture-related codes). */
  readonly requiredArchitectures?: readonly string[];
  /** What the host actually is, when we know it. */
  readonly hostArchitecture?: string;
  /** Exactly which required flags the host does not report. */
  readonly missingCpuFlags?: readonly string[];
  readonly message: string;
  /** Japanese rendering of the same facts (participants run this CLI in both locales). */
  readonly messageJa: string;
}

export type NativeCompatibilityVerdict = { readonly supported: true } | NativeCompatibilityRefusal;

/**
 * Docker and the kernel disagree on spelling for the same silicon, and a participant
 * reading `x86_64` in one place and `amd64` in another has no way to know they match.
 * Normalizing on the OCI platform names keeps one vocabulary in metadata, in messages,
 * and in the comparison itself.
 */
const ARCHITECTURE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["x86_64", "amd64"],
  ["x86-64", "amd64"],
  ["amd64", "amd64"],
  ["aarch64", "arm64"],
  ["arm64", "arm64"],
  ["arm64/v8", "arm64"],
  ["armv8", "arm64"],
  ["i386", "386"],
  ["i686", "386"],
  ["386", "386"],
]);

/** Map a reported architecture onto its canonical OCI name, or undefined when unrecognized. */
export function normalizeArchitecture(reported: string | undefined): string | undefined {
  if (typeof reported !== "string") return undefined;
  const key = reported.trim().toLowerCase();
  if (key.length === 0) return undefined;
  // An unrecognized-but-present name is NOT normalized to itself: comparing an unknown
  // spelling against the declared list would silently answer "unsupported" when the honest
  // answer is "we do not know what this host is", and those need different messages.
  return ARCHITECTURE_ALIASES.get(key);
}

/** True when the problem declares nothing this module can act on. */
export function hasNativeRequirement(
  requirement: NativeCompatibilityRequirement | undefined,
): requirement is NativeCompatibilityRequirement {
  if (!requirement) return false;
  return (
    (requirement.nativeArchitectures?.length ?? 0) > 0 || (requirement.cpuFlags?.length ?? 0) > 0
  );
}

/**
 * The whole decision, as a pure function: requirement + what we know about the host →
 * start or refuse. Injected host facts are what make every case in the acceptance
 * criteria (native, emulated, missing flag, unknown, no-requirement) a plain unit test
 * with no Docker.
 */
export function evaluateNativeCompatibility(
  requirement: NativeCompatibilityRequirement | undefined,
  host: HostCapabilities,
): NativeCompatibilityVerdict {
  if (!hasNativeRequirement(requirement)) return { supported: true };

  const required = requirement.nativeArchitectures ?? [];
  if (required.length > 0) {
    const hostArchitecture = normalizeArchitecture(host.architecture);
    if (hostArchitecture === undefined) {
      return unknownArchitecture(required);
    }
    const accepted = required
      .map((name) => normalizeArchitecture(name))
      .filter((name): name is string => name !== undefined);
    if (!accepted.includes(hostArchitecture)) {
      return unsupportedArchitecture(required, hostArchitecture);
    }
  }

  const requiredFlags = requirement.cpuFlags ?? [];
  if (requiredFlags.length > 0) {
    if (host.cpuFlags === undefined) {
      return unknownCpuFlags(requiredFlags);
    }
    const present = new Set(host.cpuFlags.map((flag) => flag.trim().toLowerCase()));
    const missing = requiredFlags.filter((flag) => !present.has(flag.trim().toLowerCase()));
    if (missing.length > 0) return missingCpuFlags(missing);
  }

  return { supported: true };
}

function unknownArchitecture(required: readonly string[]): NativeCompatibilityRefusal {
  const list = required.join(", ");
  return {
    supported: false,
    code: "unknown_host_architecture",
    requiredArchitectures: required,
    message:
      `This problem is only meaningful on a native ${list} CPU, and the architecture of the ` +
      "Docker host could not be determined. It is not started, because a result measured " +
      "under emulation would look valid and would not be. Check that Docker is running " +
      "(`docker info`) and start it again.",
    messageJa:
      `この問題は native な ${list} CPU でのみ結果に意味があります。 Docker host の ` +
      "architecture を判定できなかったため起動しません。 emulation 上の測定値は正しく見えて " +
      "正しくないためです。 Docker が動作しているか (`docker info`) を確認して再実行してください。",
  };
}

function unsupportedArchitecture(
  required: readonly string[],
  hostArchitecture: string,
): NativeCompatibilityRefusal {
  const list = required.join(", ");
  return {
    supported: false,
    code: "unsupported_architecture",
    requiredArchitectures: required,
    hostArchitecture,
    message:
      `This problem needs a native ${list} CPU; this machine is ${hostArchitecture}. It is ` +
      "not started. Docker could run the image through emulation, but the measurement this " +
      "problem scores would be an artifact of the emulator rather than of a real CPU. Run " +
      `it on a ${list} machine.`,
    messageJa:
      `この問題は native な ${list} CPU を必要としますが、 このマシンは ${hostArchitecture} です。 ` +
      "起動しません。 Docker は emulation で image を動かせますが、 この問題が採点する測定値は " +
      `実 CPU ではなく emulator の性質になります。 ${list} のマシンで実行してください。`,
  };
}

function unknownCpuFlags(required: readonly string[]): NativeCompatibilityRefusal {
  const list = required.join(", ");
  return {
    supported: false,
    code: "unknown_cpu_flags",
    missingCpuFlags: required,
    message:
      `This problem needs the CPU features ${list}, and this host's CPU features could not ` +
      "be read. It is not started rather than assumed compatible.",
    messageJa:
      `この問題は CPU 機能 ${list} を必要としますが、 この host の CPU 機能を読み取れませんでした。 ` +
      "互換とみなさず起動しません。",
  };
}

function missingCpuFlags(missing: readonly string[]): NativeCompatibilityRefusal {
  const list = missing.join(", ");
  return {
    supported: false,
    code: "missing_cpu_flags",
    missingCpuFlags: missing,
    message:
      `This problem needs the CPU features ${list}, which this host does not report. It is ` +
      "not started, because the measurement it scores depends on them.",
    messageJa:
      `この問題は CPU 機能 ${list} を必要としますが、 この host は報告していません。 ` +
      "採点する測定値がこれらに依存するため起動しません。",
  };
}

/** Injection seam for {@link readHostCapabilities}. */
export interface HostProbe {
  /** stdout of a command, or undefined when it could not be run or exited non-zero. */
  readonly capture: (command: string, args: readonly string[]) => string | undefined;
  /** Contents of a host file, or undefined when unreadable. */
  readonly readFile: (path: string) => string | undefined;
}

const DEFAULT_PROBE: HostProbe = {
  capture: (command, args) => {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout;
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * Ask the **Docker engine** what it is running on, not this process.
 *
 * `docker info` reports the daemon's own host. That distinction is the requirement, not a
 * detail: `uname` inside a container started with `platform: linux/amd64` on an arm64 Mac
 * answers `x86_64`, because the emulator says so. Reading it there would confirm exactly
 * the situation we are trying to refuse. The control plane may itself be containerized,
 * which makes any in-process reading doubly wrong.
 */
export function readHostCapabilities(probe: HostProbe = DEFAULT_PROBE): HostCapabilities {
  return {
    architecture: readEngineArchitecture(probe),
    cpuFlags: readCpuFlags(probe),
  };
}

function readEngineArchitecture(probe: HostProbe): string | undefined {
  const raw = probe.capture("docker", ["info", "--format", "{{.Architecture}}"]);
  const reported = raw?.trim();
  if (!reported) return undefined;
  // Kept as reported; normalization is the evaluator's job, and it needs to be able to
  // tell "unrecognized spelling" from "absent".
  return reported;
}

/**
 * CPU flags come from the host's `/proc/cpuinfo`. Undefined means "could not read",
 * which the evaluator turns into a refusal — an empty array would instead mean "read it,
 * the CPU has no flags", and those must not collapse into one value.
 */
function readCpuFlags(probe: HostProbe): readonly string[] | undefined {
  const cpuinfo = probe.readFile("/proc/cpuinfo");
  if (cpuinfo === undefined) return undefined;
  for (const line of cpuinfo.split("\n")) {
    const [label, value] = line.split(":", 2);
    if (label === undefined || value === undefined) continue;
    const key = label.trim().toLowerCase();
    // x86 spells it `flags`; arm64 spells it `Features`.
    if (key !== "flags" && key !== "features") continue;
    return value
      .trim()
      .split(/\s+/)
      .filter((flag) => flag.length > 0)
      .map((flag) => flag.toLowerCase());
  }
  return undefined;
}

/**
 * Build the lifecycle's compatibility gate from the catalog. The host is probed **once**
 * per session and reused: it cannot change while the daemon is up, and re-running
 * `docker info` on every start would put a subprocess in the hot path of an operation that
 * is supposed to be cheap when it succeeds.
 */
export function createNativeCompatibilityGate(
  requirementOf: (problemId: string) => NativeCompatibilityRequirement | undefined,
  readHost: () => HostCapabilities = () => readHostCapabilities(),
): (problemId: string) => NativeCompatibilityVerdict {
  let host: HostCapabilities | undefined;
  return (problemId) => {
    const requirement = requirementOf(problemId);
    // Probe lazily: a catalog where nothing declares a requirement must not pay for a
    // `docker info` at all, and most sessions are exactly that.
    if (!hasNativeRequirement(requirement)) return { supported: true };
    host ??= readHost();
    return evaluateNativeCompatibility(requirement, host);
  };
}
