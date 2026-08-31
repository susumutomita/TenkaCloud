import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

const APP_WITHOUT_OPT_OUT = /new (?:cdk\.)?App\s*\((?!\{\s*autoSynth:\s*false(?:\s*[,}]))/;

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("CDK test App lifecycle (Issue #3136)", () => {
  it("should keep test Apps out of CDK's process-level auto-synth lifecycle", () => {
    const before = process.listenerCount("beforeExit");
    const apps = Array.from({ length: 12 }, () => new App({ autoSynth: false }));

    expect(apps).toHaveLength(12);
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("should require every App constructed by the infrastructure suite to opt out", () => {
    const offenders = typescriptFiles(__dirname).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) => (APP_WITHOUT_OPT_OUT.test(line) ? [`${file}:${index + 1}`] : [])),
    );

    expect(offenders).toEqual([]);
  });
});
