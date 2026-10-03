/**
 * CSV field escaping with spreadsheet formula-injection neutralization (#1388).
 *
 * Two responsibilities:
 *  1. RFC 4180 quoting — wrap in double-quotes and double any inner quote when the value contains
 *     a delimiter (`,`), a quote (`"`), or a line break (`\n` / `\r`).
 *  2. Formula-injection defense — if the value begins with a spreadsheet formula trigger
 *     (`=`, `+`, `-`, `@`, tab, or CR), prefix it with a single quote so Excel / Google Sheets
 *     treat the cell as text instead of executing it. Audit-log columns such as `userAgent`
 *     (straight from the request header) and `target` are attacker-influenced, so an exported
 *     CSV opened by an admin must not run `=HYPERLINK(...)` / `=cmd|...` payloads.
 *
 * Neutralized values are always quoted so the leading `'` survives spreadsheet round-tripping.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvEscapeField(value: string): string {
  const neutralized = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  const needsQuote =
    neutralized !== value ||
    neutralized.includes(",") ||
    neutralized.includes('"') ||
    neutralized.includes("\n") ||
    neutralized.includes("\r");
  return needsQuote ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}
