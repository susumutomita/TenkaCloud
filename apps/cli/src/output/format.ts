/**
 * Issue #1305: CLI 出力 formatter。
 *
 * 3 mode:
 *   - "json"   : raw JSON (= pipe で jq に渡せる)
 *   - "csv"    : comma-separated (= excel / DB import)
 *   - "pretty" : ascii box table (= 人間が読む default)
 *
 * 単一 record / array record / scalar message に対応。
 */

export type OutputFormat = "json" | "csv" | "pretty";

export interface FormatOptions {
  /** column 順を強制 (= 指定なければ最初の row の key 順) */
  readonly columns?: readonly string[];
  /** 単発 record / scalar 用 (= "OK" / "Deleted: tenant-123") */
  readonly message?: string;
}

export function parseFormat(flags: readonly string[]): OutputFormat {
  if (flags.includes("--json")) return "json";
  if (flags.includes("--csv")) return "csv";
  return "pretty";
}

function toRecords(data: unknown): Record<string, unknown>[] {
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) {
    return data.map((row) =>
      typeof row === "object" && row !== null ? (row as Record<string, unknown>) : { value: row },
    );
  }
  if (typeof data === "object") return [data as Record<string, unknown>];
  return [{ value: data }];
}

function collectColumns(records: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) set.add(k);
  return [...set];
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatCsv(data: unknown, options: FormatOptions = {}): string {
  const records = toRecords(data);
  if (records.length === 0) return "";
  const columns = options.columns ?? collectColumns(records);
  const header = columns.map(escapeCsv).join(",");
  const rows = records.map((r) => columns.map((c) => escapeCsv(stringify(r[c]))).join(","));
  return [header, ...rows].join("\n");
}

export function formatPretty(data: unknown, options: FormatOptions = {}): string {
  if (typeof data === "string") return data;
  const records = toRecords(data);
  if (records.length === 0) return options.message ?? "(no results)";
  const columns = options.columns ?? collectColumns(records);
  const rows = records.map((r) => columns.map((c) => stringify(r[c])));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const fmt = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => pad(c, widths[i] ?? 0)).join(" | ")} |`;
  return [sep, fmt(columns), sep, ...rows.map(fmt), sep].join("\n");
}

export function formatOutput(
  data: unknown,
  format: OutputFormat,
  options: FormatOptions = {},
): string {
  switch (format) {
    case "json":
      return formatJson(data);
    case "csv":
      return formatCsv(data, options);
    case "pretty":
      return formatPretty(data, options);
  }
}
