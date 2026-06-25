import { describe, expect, it } from "vitest";
import { type SpawnResult, spawnCapture, spawnInherit } from "../../../scripts/lib/spawn-utils";

/**
 * Shared spawn helpers extracted from the TenkaCloud orchestration CLI
 * (tenkacloud-lite). These are the **default** implementations
 * injected into the CLI's `CliIO`, so we pin their real process behavior here:
 * exit codes, stdout / stderr capture, and the spawn-error → code 127 fallback.
 *
 * `process.execPath` (= the running node binary) is used as a portable target so
 * the test stays cross-platform and does not depend on a shell.
 */

describe("spawnCapture", () => {
  it("should capture stdout and resolve with exit code 0 on success", async () => {
    const result: SpawnResult = await spawnCapture(process.execPath, [
      "-e",
      "process.stdout.write('hello-stdout')",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello-stdout");
    expect(result.stderr).toBe("");
  });

  it("should capture stderr and a non-zero exit code on failure", async () => {
    const result = await spawnCapture(process.execPath, [
      "-e",
      "process.stderr.write('boom'); process.exit(3)",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("boom");
    expect(result.stdout).toBe("");
  });

  it("should resolve with code 127 and empty stdout when the binary is missing", async () => {
    const result = await spawnCapture("tenkacloud-no-such-binary-xyz", []);
    expect(result.code).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("spawnInherit", () => {
  it("should resolve with the child exit code on success", async () => {
    const code = await spawnInherit(process.execPath, ["-e", "process.exit(0)"]);
    expect(code).toBe(0);
  });

  it("should resolve with the child non-zero exit code on failure", async () => {
    const code = await spawnInherit(process.execPath, ["-e", "process.exit(5)"]);
    expect(code).toBe(5);
  });

  it("should resolve with code 127 when the binary is missing", async () => {
    const code = await spawnInherit("tenkacloud-no-such-binary-xyz", []);
    expect(code).toBe(127);
  });
});
