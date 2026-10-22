import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOptions } from "../local-host/options";
import {
  planChangedTests,
  readReferenceIndex,
  readWorkspaceNodes,
  repositoryFiles,
} from "../workspace/test-changed";

/**
 * Issue #3452: the `tenkacloud-setup` skill hands users make targets and `make local` flags to
 * run, and matches host messages to their causes. These checks read the skill, the Makefile,
 * `scripts/local-host/options.ts` and the `scripts/` sources as they are, so renaming or removing
 * a target, flag or message fails here instead of in a user's terminal. The diagnosis table puts
 * repository messages in code spans and quotes other tools' messages as plain text.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SKILL_PATH = ".claude/skills/tenkacloud-setup/SKILL.md";
const skill = readFileSync(join(ROOT, SKILL_PATH), "utf8");

/* eslint-disable sonarjs/no-hardcoded-ip -- Example option values for the parser; no connection is made. */
/** Values for the placeholders that the skill tells Claude Code to fill in. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "<host-ip>": "100.96.12.34",
  "<pool-cidr>": "10.77.0.0/24",
};
/* eslint-enable sonarjs/no-hardcoded-ip */

const FENCE = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gmu;

/** Fenced blocks and inline code spans: the skill writes every command in one of them. */
function codeIn(markdown: string): string[] {
  const fenced = [...markdown.matchAll(FENCE)].map((match) => match[1]);
  const inline = [...markdown.replace(FENCE, "").matchAll(/`([^`\n]+)`/gu)].map(
    (match) => match[1],
  );
  return [...fenced, ...inline];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const code = codeIn(skill);
const trackedFiles = repositoryFiles(ROOT);

function makefileTargets(): Set<string> {
  const makefile = readFileSync(join(ROOT, "Makefile"), "utf8");
  return new Set([...makefile.matchAll(/^([\w-]+)\s*:(?!=)/gmu)].map((match) => match[1]));
}

function optionsError(args: readonly string[]): unknown {
  try {
    parseOptions([...args], ROOT, {});
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("tenkacloud-setup skill", () => {
  it("names only make targets that the Makefile defines", () => {
    const targets = makefileTargets();
    const named = unique(
      code.flatMap((text) => [...text.matchAll(/\bmake ([a-z][\w-]*)/gu)].map((match) => match[1])),
    );
    expect(named.filter((target) => !targets.has(target))).toEqual([]);
  });

  it("gives make local only argument lists that options.ts accepts", () => {
    const argumentLists = unique(
      code.flatMap((text) => [...text.matchAll(/LOCAL_ARGS="([^"]*)"/gu)].map((match) => match[1])),
    );
    const rejected = argumentLists.flatMap((list) => {
      const args = list
        .split(/\s+/u)
        .filter(Boolean)
        .map((arg) => PLACEHOLDERS[arg] ?? arg);
      const error = optionsError(args);
      return error === undefined ? [] : [`${list}: ${String(error)}`];
    });
    expect(rejected).toEqual([]);
  });

  it("names only make local flags that options.ts defines", () => {
    const flags = unique(code.filter((text) => /^--[a-z][\w-]*$/u.test(text)));
    const unknown = flags.filter(
      (flag) =>
        (optionsError([flag]) as { code?: unknown } | undefined)?.code ===
        "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    );
    expect(unknown).toEqual([]);
  });

  it("quotes in the diagnosis table only messages that scripts/ prints", () => {
    const quoted = unique(
      skill
        .split("\n")
        .filter((line) => line.startsWith("| "))
        .flatMap((line) =>
          [...line.split("|")[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
        ),
    );
    const sources = trackedFiles
      .filter((file) => /^scripts\/.*(?<!\.test)\.ts$/u.test(file))
      .map((file) => readFileSync(join(ROOT, file), "utf8"));
    expect(quoted.filter((message) => !sources.some((source) => source.includes(message)))).toEqual(
      [],
    );
  });

  it("runs in make before-commit when the skill or options.ts changes", () => {
    const changed = [SKILL_PATH, "scripts/local-host/options.ts"];
    const workspaces = readWorkspaceNodes(ROOT);
    const references = readReferenceIndex(ROOT, workspaces, trackedFiles, changed);
    for (const path of changed) {
      expect(planChangedTests([path], workspaces, references)).toMatchObject({
        kind: "selected",
        suites: expect.arrayContaining(["scripts"]),
      });
    }
  });
});
