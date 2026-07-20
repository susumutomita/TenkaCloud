import { describe, expect, it } from "vitest";
import { hookCommandTargetExists } from "./hook-command-target-exists.ts";

function ctx(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    readFile: (path: string) => {
      if (!(path in files)) throw new Error(`missing: ${path}`);
      return files[path] ?? "";
    },
  };
}

function settings(command: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  });
}

describe("hookCommandTargetExists", () => {
  it("should pass when every local hook target exists", () => {
    const findings = hookCommandTargetExists.check(
      ctx({
        ".claude/settings.json": settings("bash .claude/hooks/guard-config.sh"),
        ".claude/hooks/guard-config.sh": "#!/usr/bin/env bash\n",
      }),
    );

    expect(findings).toEqual([]);
  });

  it("should flag a missing .claude hook script", () => {
    const findings = hookCommandTargetExists.check(
      ctx({
        ".claude/settings.json": settings("bash .claude/hooks/missing.sh"),
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("hook-command-target-exists");
    expect(findings[0]?.match).toBe(".claude/hooks/missing.sh");
    expect(findings[0]?.severity).toBe("error");
  });

  it("should normalize a ROOT-prefixed scripts target", () => {
    const findings = hookCommandTargetExists.check(
      ctx({
        ".claude/settings.json": settings(
          'ROOT=$(git rev-parse --show-toplevel); bun "$ROOT/scripts/ai-improvement-loop.ts"',
        ),
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("scripts/ai-improvement-loop.ts");
  });

  it("should check nested hook sections and deduplicate the same target", () => {
    const settingsWithDuplicates = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { command: "bash scripts/check.ts" },
              { command: "bun scripts/check.ts" },
            ],
          },
        ],
        Stop: [{ hooks: [{ command: "bash .claude/hooks/stop.sh" }] }],
      },
    });

    const findings = hookCommandTargetExists.check(
      ctx({
        ".claude/settings.json": settingsWithDuplicates,
        "scripts/check.ts": "export {};\n",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe(".claude/hooks/stop.sh");
  });

  it("should ignore commands without repository-local script targets", () => {
    const findings = hookCommandTargetExists.check(
      ctx({
        ".claude/settings.json": settings(
          "git diff --name-only HEAD | grep -E '\\.(ts|tsx)$' | head -1",
        ),
      }),
    );

    expect(findings).toEqual([]);
  });

  it("should skip when settings are not part of the scanned files", () => {
    const findings = hookCommandTargetExists.check(
      ctx({
        "apps/foo/src/index.ts": "export {};\n",
      }),
    );

    expect(findings).toEqual([]);
  });
});
