import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LAUNCHER_DEFAULTS_PATH,
  LAUNCHER_TEMPLATE_PATH,
  type LauncherDefaults,
  launcherDefaultsFromIdentity,
  parseLauncherDefaults,
  readLauncherDefaults,
  renderLauncherDefaults,
  stampLauncherDefaults,
} from "./generate-launcher-defaults";
import type { ReleaseIdentity } from "./identity";

const template = readFileSync(LAUNCHER_TEMPLATE_PATH, "utf8");
const committed = readLauncherDefaults();

const OTHER: LauncherDefaults = {
  manifestVersion: "9.9.9",
  platformCommit: "1".repeat(40),
  catalogCommit: "2".repeat(40),
};

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("launcher defaults stamping", () => {
  it("stamping the committed defaults into the committed template is a byte-identical no-op", () => {
    expect(stampLauncherDefaults(template, committed)).toBe(template);
  });

  it("rewrites every literal site and nothing else, reversibly and idempotently", () => {
    const stamped = stampLauncherDefaults(template, OTHER);
    expect(occurrences(stamped, OTHER.platformCommit)).toBe(3);
    expect(occurrences(stamped, OTHER.catalogCommit)).toBe(3);
    expect(occurrences(stamped, OTHER.manifestVersion)).toBe(2);
    expect(occurrences(stamped, committed.platformCommit)).toBe(0);
    expect(occurrences(stamped, committed.catalogCommit)).toBe(0);
    expect(occurrences(stamped, committed.manifestVersion)).toBe(0);
    expect(stampLauncherDefaults(stamped, OTHER)).toBe(stamped);
    expect(stampLauncherDefaults(stamped, committed)).toBe(template);
  });

  it("fails loudly when a template refactor removes or duplicates a literal site", () => {
    const withoutOutput = template.replace(
      /\n {2}ReleaseManifestVersion:\n/,
      "\n  RenamedOutput:\n",
    );
    expect(() => stampLauncherDefaults(withoutOutput, committed)).toThrow(
      'Launcher literal site "ReleaseManifestVersion output" matched 0 times',
    );
  });

  it("detects drift: a template stamped from different values no longer matches", () => {
    expect(stampLauncherDefaults(template, OTHER)).not.toBe(template);
  });

  it.each([
    [{ ...committedRaw(), platformCommit: "A".repeat(40) }, "lowercase full 40-hex platform"],
    [{ ...committedRaw(), catalogCommit: "3".repeat(39) }, "lowercase full 40-hex catalog"],
    [{ ...committedRaw(), manifestVersion: 'x" ; rm -rf' }, "letters, digits, dots, and hyphens"],
    [{ ...committedRaw(), extra: "field" }, "unknown property"],
  ])("rejects malformed defaults %j", (value, message) => {
    expect(() => parseLauncherDefaults(value)).toThrow(message);
  });

  it("rejects defaults with a missing required field", () => {
    const value = committedRaw();
    delete value.platformCommit;
    expect(() => parseLauncherDefaults(value)).toThrow("required property is missing");
  });
});

describe("advancing the launcher pair to a published tag", () => {
  const identity: ReleaseIdentity = {
    tag: "v9.9.9",
    version: "9.9.9",
    status: "candidate",
    platformCommit: "1".repeat(40),
    catalogCommit: "2".repeat(40),
    simulatorImage: `ghcr.io/susumutomita/tenkacloud-simulator@sha256:${"0".repeat(64)}`,
    toolchain: {
      bun: "1.3.11",
      node: { development: "24", launcher: "22" },
      awsCdk: { cli: "2.1133.0", library: "2.262.1" },
    },
  };

  it("derives all three values from the tag's resolved identity", () => {
    expect(launcherDefaultsFromIdentity(identity)).toEqual(OTHER);
  });

  it("renders a file the parser accepts, keeping the authoring comment", () => {
    const rendered = renderLauncherDefaults(
      launcherDefaultsFromIdentity(identity),
      "why this file",
    );
    const value = JSON.parse(rendered) as Record<string, unknown>;
    expect(value.$comment).toBe("why this file");
    expect(parseLauncherDefaults(value)).toEqual(OTHER);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("renders the committed file byte-for-byte from its own values", () => {
    const raw = committedRaw();
    expect(renderLauncherDefaults(committed, raw.$comment as string)).toBe(
      readFileSync(LAUNCHER_DEFAULTS_PATH, "utf8"),
    );
  });
});

function committedRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(LAUNCHER_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
}
