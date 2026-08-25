/**
 * Secret redaction (Issue #3036 evidence boundary: "raw credential、Authorization header、
 * cookie、session、secret output を永続化前に redact する"). Pure string transform, no I/O.
 *
 * This is a best-effort, defense-in-depth textual scrub applied to artifact content BEFORE it is
 * hashed and stored (see ./artifact-store.ts's `put`) — it is not a substitute for the orchestrator
 * never handing real credentials to Finder/Verifier/patch sandboxes in the first place (that is
 * the untrusted-execution-plane boundary, owned by Simulator per ADR-0001 §3). Applied here so
 * that even if a witness bundle or transcript-adjacent artifact happens to carry a live
 * `Authorization` header, cookie, or secret-shaped field, it never reaches durable storage intact.
 */

const REDACTED = "[REDACTED]";

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  /** Index of the capture group that holds the secret value to blank; the rest of the match is kept verbatim. */
  readonly valueGroup: number;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // `authorization: <value>` / `Authorization : Bearer xyz` as a raw header line.
  {
    name: "authorization-header",
    pattern: /(authorization\s*:\s*)([^\r\n"',}]+)/gi,
    valueGroup: 2,
  },
  // `"authorization": "<value>"` as a JSON field.
  {
    name: "authorization-json-field",
    pattern: /("authorization"\s*:\s*")([^"]*)(")/gi,
    valueGroup: 2,
  },
  // A bare `Bearer <token>` wherever it appears, independent of the above (covers e.g. a body that
  // echoes the header it received).
  // Case-insensitive (`i` flag) makes `A-Z` alone cover both cases — `a-z` would be a redundant
  // duplicate range under that flag, so the class only spells out the upper-case range.
  { name: "bearer-token", pattern: /(Bearer\s+)([A-Z0-9._~+/-]+=*)/gi, valueGroup: 2 },
  // `set-cookie: <value>` / `cookie: <value>` header lines.
  { name: "cookie-header", pattern: /((?:set-)?cookie\s*:\s*)([^\r\n]+)/gi, valueGroup: 2 },
  // JSON fields whose NAME already declares them secret-shaped. One simple, alternation-free
  // pattern per field name (instead of a single regex with a big internal alternation) keeps each
  // pattern's own complexity low and makes the list trivially extensible — this is a list to
  // audit, not a regex to parse. "token" is matched generically, not just "authToken", so a field
  // literally named `"token"` is covered without spelling out every possible prefix.
  ...[
    "password",
    "secret",
    "apikey",
    "api_key",
    "api-key",
    "sessionid",
    "session_id",
    "session-id",
    "session",
    "privatekey",
    "private_key",
    "private-key",
    "token",
  ].map(
    (fieldName): SecretPattern => ({
      name: `secret-shaped-json-field:${fieldName}`,
      pattern: new RegExp(`("${fieldName}"\\s*:\\s*")([^"]*)(")`, "gi"),
      valueGroup: 2,
    }),
  ),
];

export interface RedactionResult {
  readonly redacted: string;
  /** Count of individual matches redacted, for observability — never the secret values themselves. */
  readonly redactedCount: number;
}

/**
 * Scrubs known secret-shaped substrings out of `content`, replacing only the VALUE (never the
 * surrounding header/field name) with a fixed marker. Deterministic and total: any string in,
 * a string out, never throws.
 */
export function redactSecrets(content: string): RedactionResult {
  let redacted = content;
  let redactedCount = 0;
  for (const { pattern, valueGroup } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      // `String.replace`'s callback receives (fullMatch, capture1, capture2, ..., offset,
      // wholeString) — drop the leading full-match and the trailing (offset, wholeString) pair so
      // `captureGroups[i]` lines up with regex capture group `i + 1`.
      const captureGroups = args.slice(1, args.length - 2) as string[];
      redactedCount += 1;
      return captureGroups.map((g, i) => (i === valueGroup - 1 ? REDACTED : g)).join("");
    });
  }
  return { redacted, redactedCount };
}
