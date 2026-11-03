/** Redact decoded JSON strings and property names, including JSON-escaped credentials. */
export function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map((entry) => redactSecret(entry, secret));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(secret, "[REDACTED]"),
        redactSecret(entry, secret),
      ]),
    );
  return value;
}
