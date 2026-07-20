import type { Finding, Rule, RuleContext } from "../types.ts";

const SETTINGS_PATH = ".claude/settings.json";
const LOCAL_COMMAND_TARGET =
  /(?:\$\{?ROOT\}?\/)?((?:\.claude|scripts)\/[A-Za-z0-9_./-]+\.(?:sh|ts|js|mjs|cjs))/g;

function collectCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCommandStrings);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const commands: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "command" && typeof child === "string") {
      commands.push(child);
      continue;
    }
    commands.push(...collectCommandStrings(child));
  }
  return commands;
}

function extractLocalTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const match of command.matchAll(LOCAL_COMMAND_TARGET)) {
    const target = match[1];
    if (target) targets.add(target);
  }
  return [...targets];
}

function targetExists(ctx: RuleContext, target: string): boolean {
  try {
    ctx.readFile(target);
    return true;
  } catch {
    return false;
  }
}

export const hookCommandTargetExists: Rule = {
  id: "hook-command-target-exists",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    if (!ctx.files.includes(SETTINGS_PATH)) return [];

    let settings: unknown;
    try {
      settings = JSON.parse(ctx.readFile(SETTINGS_PATH));
    } catch {
      return [];
    }

    const targets = new Set(
      collectCommandStrings(settings).flatMap(extractLocalTargets),
    );
    const findings: Finding[] = [];
    for (const target of targets) {
      if (targetExists(ctx, target)) continue;
      findings.push({
        ruleId: "hook-command-target-exists",
        severity: "error",
        filePath: SETTINGS_PATH,
        match: target,
        message: `Claude Code hook が存在しない local command target を参照しています: ${target}`,
        recommendation:
          "stale hook を削除するか、現在の gate / script の実在 path へ置き換えてください。commit gate は .husky/pre-commit と CI を正本とし、同じ検査を複数の hook へ複製しないでください。",
      });
    }
    return findings;
  },
};
