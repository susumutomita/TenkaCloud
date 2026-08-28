const DIAGNOSTIC_LOG_LINES = 20;
const DIAGNOSTIC_LOG_CHARS = 6_000;
const SENSITIVE_LOG_KEYS = new Set([
  "flag",
  "secret",
  "password",
  "passwd",
  "token",
  "credential",
  "authorization",
  "cookie",
  "apikey",
  "accesskey",
  "privatekey",
]);
const ANSI_ESCAPE_RE = new RegExp("\\x1B\\[[0-?]*[ -/]*[@-~]", "g");

function isSensitiveLogLine(line: string): boolean {
  const separator = line.search(/[:=]/);
  if (separator < 0) return false;
  const key = line
    .slice(0, separator)
    .toLowerCase()
    .replaceAll(/[^a-z]/g, "");
  return SENSITIVE_LOG_KEYS.has(key);
}

/** Bound diagnostic output and remove credentials before it reaches a participant. */
export function redactDiagnosticLog(raw: string, sensitiveValues: readonly string[]): string {
  let value = raw.replace(ANSI_ESCAPE_RE, "");
  for (const secret of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join("[redacted]");
  }
  value = value
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[redacted]@")
    .split("\n")
    .map((line) => (isSensitiveLogLine(line) ? "[redacted sensitive log line]" : line))
    .slice(-DIAGNOSTIC_LOG_LINES)
    .join("\n")
    .trim();
  if (value.length > DIAGNOSTIC_LOG_CHARS) {
    return `${value.slice(-DIAGNOSTIC_LOG_CHARS)}\n[earlier diagnostic log output omitted]`;
  }
  return value;
}
