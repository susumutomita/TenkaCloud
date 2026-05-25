/**
 * Issue #1305: 軽量な --flag arg parser。 (commander / yargs を入れず Phase 2 内で完結)
 *
 * 例:
 *   parseFlags(["--name", "foo", "--tier", "BASIC", "--csv"])
 *   → { positional: [], flags: { name: "foo", tier: "BASIC" }, switches: ["csv"] }
 *
 *   parseFlags(["tenant-123", "--json"])
 *   → { positional: ["tenant-123"], flags: {}, switches: ["json"] }
 */

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
  readonly switches: readonly string[];
}

export function parseFlags(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const switches: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === undefined) continue;
    if (raw.startsWith("--")) {
      const key = raw.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        switches.push(key);
      }
    } else {
      positional.push(raw);
    }
  }
  return { positional, flags, switches };
}

export function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} は必須です`);
  }
  return value;
}

export function requirePositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positional[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`位置引数 ${label} は必須です`);
  }
  return value;
}
