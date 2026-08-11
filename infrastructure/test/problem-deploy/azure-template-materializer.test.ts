/**
 * [Issue #2743] Unit tests for the Azure Bicep -> inline ARM template materializer.
 * Pins the `.json` / `.bicep` dispatch, the fail-closed compiler-absent + traversal + missing-
 * artifact paths, provenance sha256 pinning, and the default CLI compiler's own compile/ENOENT
 * handling (via an injected `runBuild` fake — no real `bicep` binary required).
 */

import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AzureTemplateMaterializationError,
  BicepCompileError,
  createBicepCliCompiler,
  DEFAULT_MAX_TEMPLATE_BYTES,
  materializeAzureTemplate,
} from "../../lib/problem-deploy/runtime-clients/azure-template-materializer";

const VALID_ARM_JSON = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [],
  outputs: { AzureUrl: { type: "string", value: "https://azure.example.invalid" } },
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("materializeAzureTemplate (.json precompiled) (#2743)", () => {
  it("should read, parse, and return a valid precompiled ARM JSON entry inline", async () => {
    const readArtifact = vi.fn().mockResolvedValue(VALID_ARM_JSON);
    const result = await materializeAzureTemplate("targets/azure.json", { readArtifact });
    expect(readArtifact).toHaveBeenCalledWith("targets/azure.json");
    expect(result.document).toEqual(JSON.parse(VALID_ARM_JSON));
    expect(result.sourceSha256).toBe(sha256(VALID_ARM_JSON));
    expect(result.diagnostics).toEqual([]);
  });

  it("should match entries case-insensitively by extension", async () => {
    const readArtifact = vi.fn().mockResolvedValue(VALID_ARM_JSON);
    const result = await materializeAzureTemplate("targets/AZURE.JSON", { readArtifact });
    expect(result.document).toEqual(JSON.parse(VALID_ARM_JSON));
  });

  it("should fail closed on invalid JSON", async () => {
    const readArtifact = vi.fn().mockResolvedValue("{ not json");
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      AzureTemplateMaterializationError,
    );
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("should fail closed when the parsed document is not a JSON object", async () => {
    const readArtifact = vi.fn().mockResolvedValue("[1,2,3]");
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      /must parse as a JSON object/,
    );
  });

  it("should fail closed when $schema is missing", async () => {
    const readArtifact = vi.fn().mockResolvedValue(JSON.stringify({ resources: [] }));
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      /missing a string '\$schema'/,
    );
  });

  it("should fail closed when resources is missing or not an array", async () => {
    const readArtifact = vi.fn().mockResolvedValue(JSON.stringify({ $schema: "s" }));
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      /missing a 'resources' array/,
    );
  });

  it("should size-bound the raw template body", async () => {
    const big = JSON.stringify({ $schema: "s", resources: [], pad: "x".repeat(100) });
    const readArtifact = vi.fn().mockResolvedValue(big);
    await expect(
      materializeAzureTemplate("targets/azure.json", { readArtifact, maxTemplateBytes: 10 }),
    ).rejects.toThrow(/exceeding the 10-byte cap/);
  });

  it("should default the size cap to DEFAULT_MAX_TEMPLATE_BYTES when no override is given", async () => {
    expect(DEFAULT_MAX_TEMPLATE_BYTES).toBeGreaterThan(0);
    const oversized = JSON.stringify({
      $schema: "s",
      resources: [],
      pad: "x".repeat(DEFAULT_MAX_TEMPLATE_BYTES + 1),
    });
    const readArtifact = vi.fn().mockResolvedValue(oversized);
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      new RegExp(`exceeding the ${DEFAULT_MAX_TEMPLATE_BYTES}-byte cap`),
    );
  });
});

describe("materializeAzureTemplate (.bicep via injected compiler) (#2743)", () => {
  it("should compile a .bicep source and return the compiled ARM JSON inline", async () => {
    const source = "output AzureUrl string = 'https://azure.example.invalid'";
    const armJson = JSON.parse(VALID_ARM_JSON);
    const compiler = { compile: vi.fn().mockResolvedValue({ armJson, diagnostics: [] }) };
    const readArtifact = vi.fn().mockResolvedValue(source);
    const result = await materializeAzureTemplate("targets/azure.bicep", {
      readArtifact,
      compiler,
    });
    expect(compiler.compile).toHaveBeenCalledWith(source);
    expect(result.document).toEqual(armJson);
    expect(result.sourceSha256).toBe(sha256(source));
    expect(result.diagnostics).toEqual([]);
  });

  it("should propagate non-fatal compiler diagnostics (warnings) alongside a successful compile", async () => {
    const source = "output AzureUrl string = 'https://azure.example.invalid'";
    const armJson = JSON.parse(VALID_ARM_JSON);
    const compiler = {
      compile: vi
        .fn()
        .mockResolvedValue({ armJson, diagnostics: ["Warning BCP035: unused param"] }),
    };
    const result = await materializeAzureTemplate("targets/azure.bicep", {
      readArtifact: vi.fn().mockResolvedValue(source),
      compiler,
    });
    expect(result.diagnostics).toEqual(["Warning BCP035: unused param"]);
  });

  it("should fail closed and surface compiler diagnostics when compile throws", async () => {
    const compiler = {
      compile: vi
        .fn()
        .mockRejectedValue(
          new BicepCompileError("bicep build exited with an error", [
            "Error BCP029: unrecognized parameter",
          ]),
        ),
    };
    await expect(
      materializeAzureTemplate("targets/azure.bicep", {
        readArtifact: vi.fn().mockResolvedValue("bad bicep"),
        compiler,
      }),
    ).rejects.toThrow(/Error BCP029: unrecognized parameter/);
  });

  it("should fall back to String(err) and an empty diagnostics/detail suffix when compile rejects with a non-Error, non-BicepCompileError value", async () => {
    // A real injected BicepCompiler could reject with anything (not every implementation throws a
    // proper Error) — this covers the fallback stringification, the empty-diagnostics default, and
    // the empty detail-suffix branches all at once (Issue #2743 Codecov top-up).
    const compiler = { compile: vi.fn().mockRejectedValue("compiler process crashed") };
    await expect(
      materializeAzureTemplate("targets/azure.bicep", {
        readArtifact: vi.fn().mockResolvedValue("bad bicep"),
        compiler,
      }),
    ).rejects.toThrow("Bicep compile failed for 'targets/azure.bicep': compiler process crashed");
  });

  it("should fail closed when the compiled document fails ARM shape validation", async () => {
    const compiler = {
      compile: vi.fn().mockResolvedValue({ armJson: { no: "schema" }, diagnostics: [] }),
    };
    await expect(
      materializeAzureTemplate("targets/azure.bicep", {
        readArtifact: vi.fn().mockResolvedValue("x"),
        compiler,
      }),
    ).rejects.toThrow(/missing a string '\$schema'/);
  });

  it("should fail closed with an actionable diagnostic when no compiler is configured", async () => {
    await expect(
      materializeAzureTemplate("targets/azure.bicep", {
        readArtifact: vi.fn().mockResolvedValue("output x string = 'y'"),
      }),
    ).rejects.toThrow(/no Bicep compiler is configured/);
  });

  it("should never call readArtifact for a compile that never happens (traversal rejected first)", async () => {
    const readArtifact = vi.fn();
    await expect(
      materializeAzureTemplate("../escape.bicep", { readArtifact, compiler: { compile: vi.fn() } }),
    ).rejects.toThrow(AzureTemplateMaterializationError);
    expect(readArtifact).not.toHaveBeenCalled();
  });
});

describe("materializeAzureTemplate fail-closed dispatch (#2743)", () => {
  it("should reject an unsupported extension before reading anything", async () => {
    const readArtifact = vi.fn();
    await expect(materializeAzureTemplate("targets/azure.tf", { readArtifact })).rejects.toThrow(
      /unsupported Azure template entry/,
    );
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it.each([
    "/etc/passwd.json",
    "../../secret.json",
    "a/../../b.json",
    "a\0b.json",
    "",
  ])("should reject a traversal/absolute/empty entry '%s' before any read", async (entry) => {
    const readArtifact = vi.fn();
    await expect(materializeAzureTemplate(entry, { readArtifact })).rejects.toThrow(
      AzureTemplateMaterializationError,
    );
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("should fail closed and propagate when the artifact is missing (readArtifact throws)", async () => {
    const readArtifact = vi.fn().mockRejectedValue(new Error("artifact not found"));
    await expect(materializeAzureTemplate("targets/azure.json", { readArtifact })).rejects.toThrow(
      /artifact not found/,
    );
  });
});

describe("createBicepCliCompiler (#2743)", () => {
  it("should compile via the injected runBuild seam and surface stderr as diagnostics", async () => {
    const runBuild = vi.fn(async (_in: string, out: string) => {
      await writeFile(out, VALID_ARM_JSON, "utf8");
      return { stderr: "Warning BCP035: unused parameter 'foo'" };
    });
    const compiler = createBicepCliCompiler({ runBuild });
    const result = await compiler.compile(
      "output AzureUrl string = 'https://azure.example.invalid'",
    );
    expect(result.armJson).toEqual(JSON.parse(VALID_ARM_JSON));
    expect(result.diagnostics).toEqual(["Warning BCP035: unused parameter 'foo'"]);
    expect(runBuild).toHaveBeenCalledTimes(1);
  });

  it("should translate a runBuild ENOENT into an actionable BicepCompileError", async () => {
    const runBuild = vi.fn(async () => {
      throw Object.assign(new Error("spawn bicep ENOENT"), { code: "ENOENT" });
    });
    const compiler = createBicepCliCompiler({ runBuild });
    await expect(compiler.compile("output x string = 'y'")).rejects.toThrow(BicepCompileError);
    await expect(compiler.compile("output x string = 'y'")).rejects.toThrow(
      /bicep CLI not available in this runtime/,
    );
  });

  it("should surface a non-zero exit's stderr as diagnostics", async () => {
    const runBuild = vi.fn(async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr: "Error BCP029: unrecognized parameter\n",
      });
    });
    const compiler = createBicepCliCompiler({ runBuild });
    expect.assertions(2);
    try {
      await compiler.compile("bad bicep");
    } catch (err) {
      expect(err).toBeInstanceOf(BicepCompileError);
      expect((err as BicepCompileError).diagnostics).toEqual([
        "Error BCP029: unrecognized parameter",
      ]);
    }
  });

  it("should fall back to err.message when runBuild rejects with a plain Error that carries no stderr", async () => {
    const runBuild = vi.fn(async () => {
      throw new Error("runBuild rejected with no stderr property at all");
    });
    const compiler = createBicepCliCompiler({ runBuild });
    expect.assertions(2);
    try {
      await compiler.compile("bad bicep");
    } catch (err) {
      expect(err).toBeInstanceOf(BicepCompileError);
      expect((err as BicepCompileError).diagnostics).toEqual([
        "runBuild rejected with no stderr property at all",
      ]);
    }
  });

  it("should fall back to err.message when runBuild's stderr is present but empty", async () => {
    const runBuild = vi.fn(async () => {
      throw Object.assign(new Error("Command failed with empty stderr"), { stderr: "" });
    });
    const compiler = createBicepCliCompiler({ runBuild });
    expect.assertions(2);
    try {
      await compiler.compile("bad bicep");
    } catch (err) {
      expect(err).toBeInstanceOf(BicepCompileError);
      expect((err as BicepCompileError).diagnostics).toEqual(["Command failed with empty stderr"]);
    }
  });

  it("should reject when the compiled output is not valid JSON", async () => {
    const runBuild = vi.fn(async (_in: string, out: string) => {
      await writeFile(out, "{ not json", "utf8");
      return { stderr: "" };
    });
    const compiler = createBicepCliCompiler({ runBuild });
    await expect(compiler.compile("x")).rejects.toThrow(/non-JSON output/);
  });

  it("should reject when the compiled output is not a JSON object", async () => {
    const runBuild = vi.fn(async (_in: string, out: string) => {
      await writeFile(out, "[1,2,3]", "utf8");
      return { stderr: "" };
    });
    const compiler = createBicepCliCompiler({ runBuild });
    await expect(compiler.compile("x")).rejects.toThrow(/did not produce a JSON object/);
  });

  it("should fail closed with the real default compiler when bicep is absent from PATH", async () => {
    // PATH is pinned to an empty temp dir so execFile("bicep") deterministically
    // ENOENTs on any machine, including CI runners that ship a real bicep CLI.
    const emptyDir = await mkdtemp(join(tmpdir(), "no-bicep-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const compiler = createBicepCliCompiler();
      await expect(compiler.compile("output x string = 'y'")).rejects.toThrow(
        /bicep CLI not available in this runtime/,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("should run the real default compiler end-to-end (execFile success path) via a fake 'bicep' on PATH", async () => {
    // Exercises `defaultRunBuild`'s own success path (no injected `runBuild`) — a real child
    // process is spawned via `execFile`, writes real output to the real temp `--outfile`, and this
    // module reads it back for real. No network/binary download: the "bicep" executable is a local
    // test fixture script (Issue #2743 Codecov top-up).
    const binDir = await mkdtemp(join(tmpdir(), "fake-bicep-"));
    const fakeBicepPath = join(binDir, "bicep");
    // A POSIX shell script (invoked by the kernel via the shebang's own absolute `/bin/sh` path, so
    // it works even with PATH pinned to `binDir` alone) using only shell builtins — no `node`/`env`
    // lookup required, unlike a `#!/usr/bin/env node` script would need.
    await writeFile(
      fakeBicepPath,
      [
        "#!/bin/sh",
        'outfile=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--outfile" ]; then outfile="$arg"; fi',
        '  prev="$arg"',
        "done",
        `printf '%s' '${VALID_ARM_JSON}' > "$outfile"`,
        'echo "warning: fake bicep diagnostic" 1>&2',
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeBicepPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const compiler = createBicepCliCompiler();
      const result = await compiler.compile(
        "output AzureUrl string = 'https://azure.example.invalid'",
      );
      expect(result.armJson).toEqual(JSON.parse(VALID_ARM_JSON));
      expect(result.diagnostics).toEqual(["warning: fake bicep diagnostic"]);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
