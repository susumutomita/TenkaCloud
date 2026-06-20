import { KINDS, type Kind } from "./constants";

export interface CliArgs {
  command:
    | "create"
    | "validate"
    | "list-kinds"
    | "dry-run"
    | "inspect"
    | "cost"
    | "help"
    | "interactive";
  problemId?: string;
  kind?: Kind;
  category?: "Battle" | "Challenge";
  /** dry-run --submitted <flag> (flag kind) */
  submitted?: string;
  /** dry-run --reveal-hints <count> (flag / uptime kinds) */
  revealHints?: number;
  /** dry-run --cycles <N> (uptime-flat kind) */
  cycles?: number;
  /** dry-run --pattern <s|f sequence> (uptime-flat kind, e.g. "ssfsf") */
  pattern?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  if (isHelp(argv[0])) {
    return { command: "help" };
  }
  const command = parseCommand(argv[0]);
  if (command === "list-kinds") return { command };
  if (command === "interactive") return { command };
  const problemId = parseProblemId(command, argv[1]);
  if (!problemId) return { command: "interactive" };
  const result: CliArgs = { command, problemId };
  parseFlags(argv, result);
  return result;
}

function isHelp(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
}

function parseCommand(command: string | undefined): CliArgs["command"] {
  if (
    command === "create" ||
    command === "validate" ||
    command === "list-kinds" ||
    command === "dry-run" ||
    command === "inspect" ||
    command === "cost" ||
    command === "interactive"
  ) {
    return command;
  }
  throw new Error(
    `unknown command: ${command}. Try 'help', 'list-kinds', 'create', 'validate', 'dry-run', 'inspect', 'cost', 'interactive'.`,
  );
}

function parseProblemId(
  command: CliArgs["command"],
  problemId: string | undefined,
): string | undefined {
  if (problemId) return problemId;
  if (command === "create") {
    // `create` without args -> interactive で誘導する (= 初見の onboarding 体験を改善)
    return undefined;
  }
  throw new Error(`${command} requires <problemId>`);
}

function parseFlags(argv: readonly string[], result: CliArgs): void {
  for (let i = 2; i < argv.length; i += 1) {
    i = parseFlag(argv, i, result);
  }
}

function parseFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const flag = argv[i];
  if (flag === "--kind") return parseKindFlag(argv, i, result);
  if (flag === "--category") return parseCategoryFlag(argv, i, result);
  if (flag === "--submitted") return parseSubmittedFlag(argv, i, result);
  if (flag === "--reveal-hints") return parseRevealHintsFlag(argv, i, result);
  if (flag === "--cycles") return parseCyclesFlag(argv, i, result);
  if (flag === "--pattern") return parsePatternFlag(argv, i, result);
  throw new Error(`unknown flag: ${flag}`);
}

function parseKindFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const v = argv[i + 1];
  if (!v || !(KINDS as readonly string[]).includes(v)) {
    throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  }
  result.kind = v as Kind;
  return i + 1;
}

function parseCategoryFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const v = argv[i + 1];
  if (v !== "Battle" && v !== "Challenge") {
    throw new Error(`--category must be Battle or Challenge`);
  }
  result.category = v;
  return i + 1;
}

function parseSubmittedFlag(argv: readonly string[], i: number, result: CliArgs): number {
  result.submitted = argv[i + 1] ?? "";
  return i + 1;
}

function parseRevealHintsFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("--reveal-hints must be a non-negative integer");
  }
  result.revealHints = n;
  return i + 1;
}

function parseCyclesFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--cycles must be a positive integer");
  }
  result.cycles = n;
  return i + 1;
}

function parsePatternFlag(argv: readonly string[], i: number, result: CliArgs): number {
  const v = argv[i + 1];
  // pattern は kind 別に意味が違うため caller で validation (= runDryRun 内)。
  // 文字種は s/f (uptime), e/l/c/a (phased-polling), 0-9 (attack-detection) を許容。
  if (typeof v !== "string" || !/^[a-z0-9]+$/.test(v)) {
    throw new Error(
      "--pattern must be a non-empty string of [a-z0-9] (e.g. 'ssfsf' for uptime, 'eeeellll' for phased-polling, '12321' for attack-detection)",
    );
  }
  result.pattern = v;
  return i + 1;
}
