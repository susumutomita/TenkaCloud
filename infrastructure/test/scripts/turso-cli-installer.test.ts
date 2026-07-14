import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../../../scripts/cli/process";
import { installTursoCli, tursoCliRelease } from "../../../scripts/cli/turso-cli-installer";

describe("Turso CLI installer", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (existsSync(join(root, ".turso", "turso"))) {
        unlinkSync(join(root, ".turso", "turso"));
      }
      if (existsSync(join(root, ".turso"))) {
        rmdirSync(join(root, ".turso"));
      }
      rmdirSync(root);
    }
  });

  it("should map supported macOS and Linux targets to a pinned official release", () => {
    expect(tursoCliRelease("darwin", "arm64")).toMatchObject({
      archive: "turso-cli_Darwin_arm64.tar.gz",
      version: "1.0.29",
    });
    expect(tursoCliRelease("linux", "x64")).toMatchObject({
      archive: "turso-cli_Linux_x86_64.tar.gz",
      version: "1.0.29",
    });
    expect(() => tursoCliRelease("win32", "x64")).toThrow("Unsupported");
  });

  it("should verify the release checksum before installing the Turso binary", () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tenkacloud-turso-home-"));
    roots.push(homeDirectory);
    const release = tursoCliRelease("darwin", "arm64");
    const archiveContent = "verified archive fixture";
    const run = vi.fn<ProcessRunner["run"]>((command, args) => {
      if (command === "curl") {
        const outputIndex = args.indexOf("--output");
        writeFileSync(args[outputIndex + 1] ?? "", archiveContent);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "tar") {
        const directoryIndex = args.indexOf("-C");
        writeFileSync(join(args[directoryIndex + 1] ?? "", "turso"), "binary");
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const executable = installTursoCli({
      architecture: "arm64",
      calculateChecksum: () => release.checksum,
      homeDirectory,
      platform: "darwin",
      processRunner: { run },
    });

    expect(executable).toBe(join(homeDirectory, ".turso", "turso"));
    expect(readFileSync(executable, "utf8")).toBe("binary");
    expect(run).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining([
        `https://github.com/tursodatabase/turso-cli/releases/download/v${release.version}/${release.archive}`,
      ]),
    );
  });

  it("should fail closed and skip extraction when the checksum does not match", () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tenkacloud-turso-home-"));
    roots.push(homeDirectory);
    const run = vi.fn<ProcessRunner["run"]>((command, args) => {
      if (command !== "curl") throw new Error(`Unexpected command: ${command}`);
      const outputIndex = args.indexOf("--output");
      writeFileSync(args[outputIndex + 1] ?? "", "tampered archive");
      return { status: 0, stdout: "", stderr: "" };
    });

    expect(() =>
      installTursoCli({
        architecture: "x64",
        calculateChecksum: () => "0".repeat(64),
        homeDirectory,
        platform: "linux",
        processRunner: { run },
      }),
    ).toThrow("checksum mismatch");
    expect(run).not.toHaveBeenCalledWith("tar", expect.anything());
  });

  it("should reject a symlinked installation directory before downloading", () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tenkacloud-turso-home-"));
    const redirectedDirectory = mkdtempSync(join(tmpdir(), "tenkacloud-turso-redirect-"));
    symlinkSync(redirectedDirectory, join(homeDirectory, ".turso"), "dir");
    const run = vi.fn<ProcessRunner["run"]>(() => {
      throw new Error("download should not start");
    });

    expect(() =>
      installTursoCli({
        architecture: "arm64",
        homeDirectory,
        platform: "darwin",
        processRunner: { run },
      }),
    ).toThrow("regular directory");
    expect(run).not.toHaveBeenCalled();

    unlinkSync(join(homeDirectory, ".turso"));
    rmdirSync(redirectedDirectory);
    rmdirSync(homeDirectory);
  });
});
