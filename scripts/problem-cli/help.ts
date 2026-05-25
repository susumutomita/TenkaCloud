import { KIND_TO_DEFAULT_CATEGORY, KINDS } from "./constants";

export function printHelp(): void {
  console.log(`tenkacloud problem — TenkaCloud 問題 authoring CLI (ADR-012 Phase 6)

Usage:
  bun run scripts/tenkacloud-problem.ts create <id> --kind <kind> [--category Battle|Challenge]
  bun run scripts/tenkacloud-problem.ts create               # interactive (= 初心者向け、 引数なしで起動)
  bun run scripts/tenkacloud-problem.ts interactive          # 上と同じ (= 明示形)
  bun run scripts/tenkacloud-problem.ts validate <id>
  bun run scripts/tenkacloud-problem.ts dry-run <id> [--submitted <flag>] [--reveal-hints N]
                                                    [--cycles N] [--pattern <s|f sequence>]
  bun run scripts/tenkacloud-problem.ts inspect <id>  # metadata + template の全体 dump (= author debug)
  bun run scripts/tenkacloud-problem.ts list-kinds

Available kinds:  ${KINDS.join(", ")}

Examples:
  bun run scripts/tenkacloud-problem.ts create my-battle --kind uptime-multi
  bun run scripts/tenkacloud-problem.ts create hello-flag --kind flag
  bun run scripts/tenkacloud-problem.ts create        # 対話形式で kind / id / category を選ぶ
  bun run scripts/tenkacloud-problem.ts validate microservice-migration-battle
  bun run scripts/tenkacloud-problem.ts dry-run hello-world --submitted "actual-flag-value"
  bun run scripts/tenkacloud-problem.ts dry-run hello-world-battle --cycles 60 --pattern "ssssffssssss"
  bun run scripts/tenkacloud-problem.ts inspect hello-world

See also:
  docs/problems/CONTRIBUTING.md  — external contributor quickstart (decision tree + lifecycle)
  docs/problems/AUTHORING.html   — 30 分 onboarding guide (full field reference)
  docs/problems/EXAMPLES.md      — design retrospectives on the 5 reference problems
  docs/problems/AI-WORKFLOW.md   — Claude Code / Codex CLI authoring workflow
  problems/SCHEMA.json           — metadata.json schema
  .claude/skills/create-problem  — Claude Code skill (= /create-problem)
`);
}

export function listKinds(): void {
  for (const k of KINDS) {
    console.log(`${k.padEnd(20)} → category=${KIND_TO_DEFAULT_CATEGORY[k]}`);
  }
}
