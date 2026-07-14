import { describe, expect, it } from "vitest";
import {
  type ComposeService,
  classifyService,
  describeFailure,
  evaluateHealth,
  looksDiskFull,
  parseComposePs,
  parseDiskUsePercent,
  parseLongRunning,
  runSmoke,
  type SmokeDeps,
} from "../../../scripts/local-play/local-smoke";

const NONE_LONG_RUNNING = () => false;

const svc = (over: Partial<ComposeService>): ComposeService => ({
  name: "tc-local-x-web-1",
  service: "web",
  state: "running",
  health: "healthy",
  exitCode: 0,
  ...over,
});

const psLine = (over: Partial<ComposeService>): string => {
  const s = svc(over);
  return JSON.stringify({
    Name: s.name,
    Service: s.service,
    State: s.state,
    Health: s.health,
    ExitCode: s.exitCode,
  });
};

describe("parseComposePs", () => {
  it("should parse newline-delimited compose ps json", () => {
    const out = `${psLine({ service: "db" })}\n${psLine({ service: "web" })}`;
    expect(parseComposePs(out).map((s) => s.service)).toEqual(["db", "web"]);
  });

  it("should parse the json-array form", () => {
    const out = `[${psLine({ service: "db" })},${psLine({ service: "web" })}]`;
    expect(parseComposePs(out)).toHaveLength(2);
  });

  it("should return an empty array for empty output", () => {
    expect(parseComposePs("   \n  ")).toEqual([]);
  });

  it("should default missing fields", () => {
    const [row] = parseComposePs(JSON.stringify({ Service: "web" }));
    expect(row).toEqual({ name: "", service: "web", state: "", health: "", exitCode: 0 });
  });
});

describe("classifyService", () => {
  it("should treat a non-long-running one-shot that exited 0 as completed", () => {
    expect(classifyService(svc({ state: "exited", exitCode: 0, health: "" }), false)).toBe(
      "completed",
    );
  });

  it("should fail a long-running service that exited even with code 0", () => {
    expect(classifyService(svc({ state: "exited", exitCode: 0, health: "" }), true)).toBe(
      "failing",
    );
  });

  it("should treat a container that exited non-zero as failing", () => {
    expect(classifyService(svc({ state: "exited", exitCode: 1, health: "" }), false)).toBe(
      "failing",
    );
  });

  it("should treat a dead container as failing even with exit code 0", () => {
    expect(classifyService(svc({ state: "dead", exitCode: 0, health: "" }), false)).toBe("failing");
  });

  it("should treat an unhealthy running container as failing", () => {
    expect(classifyService(svc({ state: "running", health: "unhealthy" }), true)).toBe("failing");
  });

  it("should treat a running container with no healthcheck as ok", () => {
    expect(classifyService(svc({ state: "running", health: "" }), false)).toBe("ok");
  });

  it("should treat a still-starting container as pending", () => {
    expect(classifyService(svc({ state: "running", health: "starting" }), true)).toBe("pending");
  });

  it("should treat a created container as pending", () => {
    expect(classifyService(svc({ state: "created", health: "" }), true)).toBe("pending");
  });
});

describe("parseLongRunning", () => {
  it("should treat a healthcheck or ports marker as long-running", () => {
    expect(parseLongRunning("HP")).toBe(true);
    expect(parseLongRunning("H")).toBe(true);
    expect(parseLongRunning("P")).toBe(true);
  });

  it("should treat an empty marker as not long-running", () => {
    expect(parseLongRunning("")).toBe(false);
    expect(parseLongRunning("\n")).toBe(false);
  });
});

describe("evaluateHealth", () => {
  it("should be ok when a service runs and one-shots complete", () => {
    const report = evaluateHealth(
      [svc({}), svc({ state: "exited", exitCode: 0, health: "" })],
      NONE_LONG_RUNNING,
    );
    expect(report).toMatchObject({ done: true, ok: true });
    expect(report.running).toHaveLength(1);
  });

  it("should fail when a long-running service exits cleanly while a sidecar keeps running", () => {
    const web = svc({ name: "web-1", service: "web", state: "exited", exitCode: 0, health: "" });
    const db = svc({ name: "db-1", service: "db", state: "running", health: "healthy" });
    const report = evaluateHealth([web, db], (service) => service.name === "web-1");
    expect(report).toMatchObject({ done: true, ok: false });
    expect(report.failing.map((s) => s.service)).toEqual(["web"]);
    expect(report.running.map((s) => s.service)).toEqual(["db"]);
  });

  it("should NOT be ok when everything exited and nothing is running", () => {
    const report = evaluateHealth(
      [
        svc({ service: "a", state: "exited", exitCode: 0, health: "" }),
        svc({ service: "b", state: "exited", exitCode: 0, health: "" }),
      ],
      NONE_LONG_RUNNING,
    );
    expect(report).toMatchObject({ done: true, ok: false });
    expect(report.running).toHaveLength(0);
  });

  it("should be not-done while a service is still pending", () => {
    const report = evaluateHealth([svc({ health: "starting" }), svc({})], NONE_LONG_RUNNING);
    expect(report).toMatchObject({ done: false, ok: false });
    expect(report.pending).toHaveLength(1);
  });

  it("should be done-and-not-ok as soon as a service fails, even with others pending", () => {
    const report = evaluateHealth(
      [svc({ state: "exited", exitCode: 1, health: "" }), svc({ health: "starting" })],
      NONE_LONG_RUNNING,
    );
    expect(report).toMatchObject({ done: true, ok: false });
    expect(report.failing).toHaveLength(1);
  });
});

describe("parseDiskUsePercent", () => {
  it("should read the use-percent of the root filesystem", () => {
    const df = "Filesystem Size Used Avail Use% Mounted on\noverlay 97.9G 93.3G 0 100% /";
    expect(parseDiskUsePercent(df)).toBe(100);
  });

  it("should return null when no root row is present", () => {
    expect(parseDiskUsePercent("Filesystem Size Used\ntmpfs 1G 0 1G 0% /tmp")).toBeNull();
  });
});

describe("looksDiskFull", () => {
  it("should detect a no-space failure", () => {
    expect(
      looksDiskFull("mariadbd: Error writing file (Errcode: 28 'No space left on device')"),
    ).toBe(true);
  });

  it("should not flag unrelated logs", () => {
    expect(looksDiskFull("normal startup, listening on 8080")).toBe(false);
  });
});

describe("describeFailure", () => {
  it("should include exit code and health when abnormal", () => {
    expect(describeFailure(svc({ service: "db", state: "exited", exitCode: 1, health: "" }))).toBe(
      "db(exited exit 1)",
    );
    expect(
      describeFailure(svc({ service: "wp", state: "running", exitCode: 0, health: "unhealthy" })),
    ).toBe("wp(running unhealthy)");
    expect(describeFailure(svc({ service: "x", state: "dead", exitCode: 0, health: "" }))).toBe(
      "x(dead)",
    );
  });
});

const OPTS = { diskThresholdPercent: 90, timeoutMs: 180_000, pollMs: 1 } as const;
const PLUGIN = { command: "docker", prefix: ["compose"] as const };

interface Script {
  info?: number;
  df?: { status: number; stdout?: string };
  up?: number;
  ps?: string[];
  logs?: string;
  clock?: number[];
  composeCli?: { command: string; prefix: readonly string[] };
  /** `docker inspect` long-running marker (e.g. "HP") returned for every exited service. */
  inspect?: string;
  /** Exit status of `docker inspect` (non-zero simulates an inspect failure). */
  inspectStatus?: number;
}

type RunResult = { status: number; stdout: string; stderr: string };

function mockDeps(script: Script): { deps: SmokeDeps; calls: string[][]; logs: string[] } {
  const calls: string[][] = [];
  const logs: string[] = [];
  let psIdx = 0;
  let nowIdx = 0;
  const direct: Record<string, () => RunResult> = {
    "docker info": () => ({ status: script.info ?? 0, stdout: "", stderr: "" }),
    "docker run": () => ({
      status: script.df?.status ?? 0,
      stdout: script.df?.stdout ?? "overlay 10G 1G 9G 5% /",
      stderr: "",
    }),
    "docker logs": () => ({ status: 0, stdout: script.logs ?? "", stderr: "" }),
    "docker inspect": () => ({
      status: script.inspectStatus ?? 0,
      stdout: script.inspect ?? "",
      stderr: "",
    }),
    "make local-up": () => ({ status: script.up ?? 0, stdout: "", stderr: "up failed" }),
  };
  const deps: SmokeDeps = {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      const handler = direct[`${cmd} ${args[0] ?? ""}`];
      if (handler) return handler();
      const flat = [cmd, ...args];
      if (flat.includes("down")) return { status: 0, stdout: "", stderr: "" }; // compose down
      if (flat.includes("ps")) {
        const seq = script.ps ?? ["[]"];
        return { status: 0, stdout: seq[Math.min(psIdx++, seq.length - 1)], stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" }; // make local-down etc.
    },
    composeCli: script.composeCli ?? PLUGIN,
    sleep: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    now: () => {
      const clock = script.clock ?? [0];
      return clock[Math.min(nowIdx++, clock.length - 1)];
    },
  };
  return { deps, calls, logs };
}

describe("runSmoke", () => {
  it("should fail when the docker daemon is unreachable", async () => {
    const { deps, logs } = mockDeps({ info: 1 });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("Docker daemon is not reachable");
  });

  it("should fail preflight when the VM disk is above the threshold", async () => {
    const { deps, logs } = mockDeps({ df: { status: 0, stdout: "overlay 97G 93G 0 95% /" } });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("95% full");
  });

  it("should continue when the disk measurement itself fails", async () => {
    const { deps, logs } = mockDeps({ df: { status: 1 }, ps: [psLine({})] });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(0);
    expect(logs.join("\n")).toContain("Could not measure Docker VM disk");
  });

  it("should tolerate a disk row it cannot parse into a percent", async () => {
    const { deps, logs } = mockDeps({
      df: { status: 0, stdout: "no root row here" },
      ps: [psLine({})],
    });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(0);
    expect(logs.join("\n")).toContain("? % used".replace(" ", ""));
  });

  it("should pass when a container is running and healthy", async () => {
    const { deps, calls } = mockDeps({ ps: [psLine({})] });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(0);
    expect(calls.some((c) => c[0] === "make" && c[1] === "local-down")).toBe(true);
  });

  it("should query with -a so a crashed container cannot hide", async () => {
    const { deps, calls } = mockDeps({ ps: [psLine({})] });
    await runSmoke(deps, "sqli-demo", OPTS);
    expect(calls).toContainEqual([
      "docker",
      "compose",
      "-p",
      "tc-local-sqli-demo",
      "ps",
      "-a",
      "--format",
      "json",
    ]);
  });

  it("should use the standalone docker-compose CLI when that is what is resolved", async () => {
    const { deps, calls } = mockDeps({
      ps: [psLine({})],
      composeCli: { command: "docker-compose", prefix: [] },
    });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(0);
    expect(calls).toContainEqual([
      "docker-compose",
      "-p",
      "tc-local-sqli-demo",
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    expect(calls).toContainEqual([
      "docker-compose",
      "-p",
      "tc-local-sqli-demo",
      "down",
      "-v",
      "--remove-orphans",
    ]);
  });

  it("should fail when a long-running service exits cleanly while a sidecar keeps running", async () => {
    const web = psLine({ name: "web-1", service: "web", state: "exited", exitCode: 0, health: "" });
    const db = psLine({ name: "db-1", service: "db", state: "running", health: "healthy" });
    const { deps, logs } = mockDeps({ ps: [`${web}\n${db}`], inspect: "HP" });
    expect(await runSmoke(deps, "wp-exposed-backup", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("web(exited)");
  });

  it("should fail closed when docker inspect fails for a clean exit beside a running sidecar", async () => {
    // Regression: a cleanly-exited service whose `docker inspect` fails, next to a
    // healthy sidecar that keeps `running > 0` true on its own. Without fail-closed
    // handling the exit is misread as a permitted one-shot and the run false-passes;
    // the sidecar makes the `running > 0` check unable to catch it, so only the
    // fail-closed logic can. If this returned 0, the fail-closed fix regressed.
    const web = psLine({ name: "web-1", service: "web", state: "exited", exitCode: 0, health: "" });
    const db = psLine({ name: "db-1", service: "db", state: "running", health: "healthy" });
    const { deps, logs } = mockDeps({ ps: [`${web}\n${db}`], inspectStatus: 1 });
    expect(await runSmoke(deps, "wp-exposed-backup", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("web(exited)");
  });

  it("should fail when every container exits and none stays running", async () => {
    const { deps, logs } = mockDeps({
      ps: [`${psLine({ service: "a", state: "exited", exitCode: 0, health: "" })}`],
    });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("No container stayed running");
  });

  it("should tear down the compose project even when the problem never starts", async () => {
    const { deps, calls } = mockDeps({ up: 1, ps: ["[]"] });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(calls).toContainEqual([
      "docker",
      "compose",
      "-p",
      "tc-local-sqli-demo",
      "down",
      "-v",
      "--remove-orphans",
    ]);
  });

  it("should poll through a starting state until healthy", async () => {
    const { deps, calls } = mockDeps({
      ps: [psLine({ health: "starting" }), psLine({ health: "healthy" })],
      clock: [0, 10, 20],
    });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(0);
    const psCalls = calls.filter((c) => c.includes("ps"));
    expect(psCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("should fail and surface a disk-full hint when a container crashes on a full disk", async () => {
    const { deps, logs } = mockDeps({
      ps: [psLine({ service: "db", state: "exited", exitCode: 1, health: "" })],
      logs: "mariadbd: Error writing file './ddl_recovery.log' (Errcode: 28 'No space left on device')",
    });
    expect(await runSmoke(deps, "wp-exposed-backup", OPTS)).toBe(1);
    const text = logs.join("\n");
    expect(text).toContain("db(exited exit 1)");
    expect(text).toContain("No space left on device");
  });

  it("should fail loudly and diagnose when the problem never starts", async () => {
    const { deps, logs } = mockDeps({ up: 1, ps: ["[]"] });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("failed to start");
  });

  it("should fail on timeout while containers stay pending", async () => {
    const { deps, logs } = mockDeps({
      ps: [psLine({ health: "starting" })],
      clock: [0, 10_000_000],
    });
    expect(await runSmoke(deps, "sqli-demo", OPTS)).toBe(1);
    expect(logs.join("\n")).toContain("Timed out");
  });
});
