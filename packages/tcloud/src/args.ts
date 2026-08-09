/**
 * Issue #2951: 引数パーサ。外部依存を足さない (この CLI の依存は 0 本のままにする)。
 *
 * `--key value` と `--key=value` の両方を受ける。値の無い `--key` は flag として true になる。
 */

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[body] = next;
      index += 1;
      continue;
    }
    options[body] = true;
  }

  return { positional, options };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 値を持つ option を必須で取り出す。flag 形 (`--x` だけ) はエラーにする。 */
export function requireOption(args: ParsedArgs, name: string): string {
  const value = args.options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${name} <value> が必要です。`);
  }
  return value;
}

export function optionalOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requirePositional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (value === undefined || value.length === 0) {
    throw new UsageError(`${label} を指定してください。`);
  }
  return value;
}
