import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LocalPaths,
  readLocalProcessState,
  readPrivateJson,
  readRecordedUnits,
  writePrivateText,
} from "../../../scripts/local-play/session-state";

function localPaths(directory: string): LocalPaths {
  return {
    localDir: directory,
    statePath: join(directory, "state.json"),
    deploymentPath: join(directory, "deployment.json"),
    unitsPath: join(directory, "units.json"),
    runtimeConfigBackupPath: join(directory, "runtime-config.backup.json"),
    logPath: join(directory, "api.log"),
    simulatorSessionPath: join(directory, "simulator-session.json"),
    simulatorStateDir: join(directory, "simulator-state"),
    simulatorLogPath: join(directory, "simulator.log"),
    simulatorEnvPath: join(directory, "simulator-native.env"),
    databasePath: join(directory, "local-play.sqlite"),
    runtimeConfigPath: join(directory, "runtime-config.json"),
  };
}

describe("local-play private session state", () => {
  it("should create a private file with mode 0600", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const path = join(directory, "state.json");
    try {
      writePrivateText(path, "secret\n");

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("secret\n");
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  });

  it("should reject a symbolic-link destination without modifying its target", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const target = join(directory, "target.txt");
    const path = join(directory, "state.json");
    writeFileSync(target, "unchanged\n", "utf8");
    symlinkSync(target, path);
    try {
      expect(() => writePrivateText(path, "secret\n")).toThrow();
      expect(readFileSync(target, "utf8")).toBe("unchanged\n");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      unlinkSync(path);
      unlinkSync(target);
      rmdirSync(directory);
    }
  });

  it("should reject a symbolic-link source when reading protected state", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const target = join(directory, "target.json");
    const path = join(directory, "state.json");
    writeFileSync(target, '{"secret":"must-not-follow"}\n', "utf8");
    symlinkSync(target, path);
    try {
      expect(() => readPrivateJson(path)).toThrow();
    } finally {
      unlinkSync(path);
      unlinkSync(target);
      rmdirSync(directory);
    }
  });

  it("should reject tampered process state before using a bearer or PID", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const paths = localPaths(directory);
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        pid: process.pid,
        processIdentity: "0".repeat(64),
        apiBaseUrl: "https://attacker.example",
        problemIds: ["hello-world"],
        deploymentPath: paths.deploymentPath,
        runtimeConfigPath: paths.runtimeConfigPath,
        participantToken: "a".repeat(43),
      }),
      "utf8",
    );
    try {
      expect(() => readLocalProcessState(paths.statePath, paths)).toThrow(
        "non-loopback Participant API origin",
      );
    } finally {
      unlinkSync(paths.statePath);
      rmdirSync(directory);
    }
  });

  it("should validate the recorded local-play database backend", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const paths = localPaths(directory);
    const state = {
      pid: process.pid,
      processIdentity: "0".repeat(64),
      apiBaseUrl: "http://127.0.0.1:43199",
      problemIds: [],
      deploymentPath: paths.deploymentPath,
      runtimeConfigPath: paths.runtimeConfigPath,
      participantToken: "a".repeat(43),
    };
    try {
      writeFileSync(paths.statePath, JSON.stringify({ ...state, databaseBackend: "turso" }));
      expect(readLocalProcessState(paths.statePath, paths).databaseBackend).toBe("turso");

      writeFileSync(paths.statePath, JSON.stringify({ ...state, databaseBackend: "dynamodb" }));
      expect(() => readLocalProcessState(paths.statePath, paths)).toThrow("database backend");
    } finally {
      unlinkSync(paths.statePath);
      rmdirSync(directory);
    }
  });

  it("should reject compose ownership outside repository and local state roots", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const paths = localPaths(directory);
    writeFileSync(
      paths.unitsPath,
      JSON.stringify({
        units: [
          {
            problemId: "tampered-unit",
            composePath: "/tmp/attacker-compose.yml",
            composeProjectName: "tc-tampered",
            secretEnv: [],
          },
        ],
      }),
      "utf8",
    );
    try {
      expect(() => readRecordedUnits(paths.unitsPath, paths.localDir)).toThrow(
        "outside the repository",
      );
    } finally {
      unlinkSync(paths.unitsPath);
      rmdirSync(directory);
    }
  });

  /**
   * containerized entrypoint (`make local`) では、記録される compose path は **ホスト絶対
   * パス**でなければならない — daemon は受け取った文字列を自分の (= ホストの) filesystem で
   * 解決するため。一方 `REPO_ROOT` は module の位置から導くのでコンテナ内では `/app` になる。
   *
   * 照合根を `REPO_ROOT` だけにすると、正しく記録されたホストパスが「リポジトリ外」と判定され、
   * **問題を 1 つでも起動した session が二度と起動できなくなる** (実機で観測: コンテナが
   * `Recorded compose path is outside the repository` で exit 1)。
   *
   * `TENKACLOUD_PROBLEMS_HOST_PATH` は launcher が `problems/` を bind-mount した実際の絶対
   * パスで、コンテナ内でも同一パスに見えている。ここを根に加えるのが正しい照合であって、
   * 検査を外すことではない。
   */
  describe("containerized entrypoint (TENKACLOUD_PROBLEMS_HOST_PATH)", () => {
    const HOST_PROBLEMS = "/Users/someone/product/TenkaCloud/problems";

    function withProblemsHostPath<T>(value: string | undefined, run: () => T): T {
      const previous = process.env.TENKACLOUD_PROBLEMS_HOST_PATH;
      if (value === undefined) delete process.env.TENKACLOUD_PROBLEMS_HOST_PATH;
      else process.env.TENKACLOUD_PROBLEMS_HOST_PATH = value;
      try {
        return run();
      } finally {
        if (previous === undefined) delete process.env.TENKACLOUD_PROBLEMS_HOST_PATH;
        else process.env.TENKACLOUD_PROBLEMS_HOST_PATH = previous;
      }
    }

    function writeUnit(paths: LocalPaths, composePath: string): void {
      writeFileSync(
        paths.unitsPath,
        JSON.stringify({
          units: [
            {
              problemId: "ac26-w1-underconstraint",
              composePath,
              composeProjectName: "tc-local-ac26-w1-underconstraint",
              secretEnv: ["FLAG_SEED"],
            },
          ],
        }),
        "utf8",
      );
    }

    it("should accept a host path under the bind-mounted problems root", () => {
      const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
      const paths = localPaths(directory);
      writeUnit(
        paths,
        `${HOST_PROBLEMS}/challenges/ac26-w1-underconstraint/local/docker-compose.yml`,
      );
      try {
        const recorded = withProblemsHostPath(HOST_PROBLEMS, () =>
          readRecordedUnits(paths.unitsPath, paths.localDir),
        );
        expect(recorded.units).toHaveLength(1);
        expect(recorded.units[0]?.problemId).toBe("ac26-w1-underconstraint");
      } finally {
        unlinkSync(paths.unitsPath);
        rmdirSync(directory);
      }
    });

    it("should still reject a path outside both the repository and that problems root", () => {
      const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
      const paths = localPaths(directory);
      writeUnit(paths, "/tmp/attacker-compose.yml");
      try {
        expect(() =>
          withProblemsHostPath(HOST_PROBLEMS, () =>
            readRecordedUnits(paths.unitsPath, paths.localDir),
          ),
        ).toThrow("outside the repository");
      } finally {
        unlinkSync(paths.unitsPath);
        rmdirSync(directory);
      }
    });

    it("should ignore a relative override rather than widening to the process cwd", () => {
      const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
      const paths = localPaths(directory);
      writeUnit(paths, `${HOST_PROBLEMS}/challenges/x/local/docker-compose.yml`);
      try {
        expect(() =>
          withProblemsHostPath("problems", () =>
            readRecordedUnits(paths.unitsPath, paths.localDir),
          ),
        ).toThrow("outside the repository");
      } finally {
        unlinkSync(paths.unitsPath);
        rmdirSync(directory);
      }
    });
  });
});
