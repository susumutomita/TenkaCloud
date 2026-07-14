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
});
