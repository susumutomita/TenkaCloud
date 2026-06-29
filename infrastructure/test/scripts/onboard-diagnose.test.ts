import { describe, expect, it } from "vitest";
import {
  blockingChecks,
  type CommandOutcome,
  type CommandRunner,
  checkBun,
  checkDockerCompose,
  checkDockerDaemon,
  checkMiseTrust,
  checkSubmodule,
  type DiagnoseInput,
  diagnose,
  isReady,
} from "../../../scripts/onboard/diagnose";

const REPO = "/repo";

/** Build a CommandRunner from a map keyed by `"<command> <args...>"`. */
function runnerWith(map: Record<string, CommandOutcome>): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      return map[key] ?? { code: null, stdout: "", stderr: "" };
    },
  };
}

function fsWith(paths: readonly string[]) {
  return { existsSync: (path: string) => paths.includes(path) };
}

function input(
  over: Partial<DiagnoseInput> & { run: CommandRunner; fs: DiagnoseInput["fs"] },
): DiagnoseInput {
  return { repoRoot: REPO, ...over };
}

const OK = (stdout = ""): CommandOutcome => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = ""): CommandOutcome => ({ code: 1, stdout: "", stderr });

describe("checkMiseTrust", () => {
  it("should skip when there is no mise.toml", () => {
    const result = checkMiseTrust(input({ run: runnerWith({}), fs: fsWith([]) }));
    expect(result.status).toBe("skipped");
  });

  it("should skip when mise.toml exists but mise is not installed", () => {
    const result = checkMiseTrust(
      input({ run: runnerWith({}), fs: fsWith([`${REPO}/mise.toml`]) }),
    );
    expect(result.status).toBe("skipped");
  });

  it("should flag action-needed when mise reports the config is not trusted", () => {
    const run = runnerWith({
      "mise --version": OK("2026.1.0"),
      "mise ls": {
        code: 0,
        stdout: "",
        stderr: "Config files in /repo/mise.toml are not trusted.",
      },
    });
    const result = checkMiseTrust(input({ run, fs: fsWith([`${REPO}/mise.toml`]) }));
    expect(result.status).toBe("action-needed");
  });

  it("should be ok when mise lists tools without a trust warning", () => {
    const run = runnerWith({
      "mise --version": OK("2026.1.0"),
      "mise ls": OK("bun 1.3.11"),
    });
    const result = checkMiseTrust(input({ run, fs: fsWith([`${REPO}/mise.toml`]) }));
    expect(result.status).toBe("ok");
  });
});

describe("checkSubmodule", () => {
  it("should be ok when a category directory exists", () => {
    const result = checkSubmodule(
      input({ run: runnerWith({}), fs: fsWith([`${REPO}/problems/challenges`]) }),
    );
    expect(result.status).toBe("ok");
  });

  it("should need action when problems/ is empty", () => {
    const result = checkSubmodule(input({ run: runnerWith({}), fs: fsWith([]) }));
    expect(result.status).toBe("action-needed");
  });
});

describe("checkBun", () => {
  it("should be ok when bun --version runs", () => {
    expect(
      checkBun(input({ run: runnerWith({ "bun --version": OK("1.3.11") }), fs: fsWith([]) }))
        .status,
    ).toBe("ok");
  });

  it("should be missing when bun is not installed", () => {
    expect(checkBun(input({ run: runnerWith({}), fs: fsWith([]) })).status).toBe("missing");
  });
});

describe("checkDockerCompose", () => {
  it("should skip when the docker CLI is absent", () => {
    expect(checkDockerCompose(input({ run: runnerWith({}), fs: fsWith([]) })).status).toBe(
      "skipped",
    );
  });

  it("should be ok when the compose plugin responds", () => {
    const run = runnerWith({
      "docker --version": OK("Docker version 27"),
      "docker compose version": OK("Docker Compose version v2.30"),
    });
    expect(checkDockerCompose(input({ run, fs: fsWith([]) })).status).toBe("ok");
  });

  it("should be missing when the CLI exists but compose does not", () => {
    const run = runnerWith({
      "docker --version": OK("Docker version 27"),
      "docker compose version": FAIL(),
    });
    expect(checkDockerCompose(input({ run, fs: fsWith([]) })).status).toBe("missing");
  });
});

describe("checkDockerDaemon", () => {
  it("should skip when the docker CLI is absent", () => {
    expect(checkDockerDaemon(input({ run: runnerWith({}), fs: fsWith([]) })).status).toBe(
      "skipped",
    );
  });

  it("should be ok when docker info succeeds", () => {
    const run = runnerWith({ "docker --version": OK("v27"), "docker info": OK("Server: ...") });
    expect(checkDockerDaemon(input({ run, fs: fsWith([]) })).status).toBe("ok");
  });

  it("should need action when the CLI is present but the daemon is down", () => {
    const run = runnerWith({
      "docker --version": OK("v27"),
      "docker info": FAIL("Cannot connect to the Docker daemon"),
    });
    expect(checkDockerDaemon(input({ run, fs: fsWith([]) })).status).toBe("action-needed");
  });
});

describe("diagnose / isReady / blockingChecks", () => {
  const fullyReady = runnerWith({
    "mise --version": OK("2026.1.0"),
    "mise ls": OK("bun 1.3.11"),
    "bun --version": OK("1.3.11"),
    "docker --version": OK("v27"),
    "docker compose version": OK("v2.30"),
    "docker info": OK("Server"),
  });

  it("should report ready when every prerequisite passes", () => {
    const result = diagnose(
      input({ run: fullyReady, fs: fsWith([`${REPO}/mise.toml`, `${REPO}/problems/challenges`]) }),
    );
    expect(isReady(result)).toBe(true);
    expect(blockingChecks(result)).toHaveLength(0);
  });

  it("should surface a fresh-clone (no submodule, no docker) as blocking", () => {
    const result = diagnose(
      input({ run: runnerWith({ "bun --version": OK("1.3.11") }), fs: fsWith([]) }),
    );
    expect(isReady(result)).toBe(false);
    const ids = blockingChecks(result).map((c) => c.id);
    expect(ids).toContain("submodule");
    expect(ids).toContain("docker-cli");
    // docker-compose / docker-daemon are skipped (CLI absent) — not blocking.
    expect(ids).not.toContain("docker-compose");
    expect(ids).not.toContain("docker-daemon");
  });
});
