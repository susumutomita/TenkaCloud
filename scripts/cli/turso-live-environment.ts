import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "dotenv";

export interface LoadedTursoLiveEnvironment {
  readonly path: string;
  readonly exists: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export function tursoLiveEnvironmentPath(repoRoot: string, environment: string): string {
  return join(repoRoot, "infrastructure", "environments", environment, ".env");
}

function assertRegularEnvironmentFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link environment file: ${path}`);
  if (!stat.isFile()) throw new Error(`Environment path is not a regular file: ${path}`);
}

export function loadTursoLiveEnvironment(
  repoRoot: string,
  environment: string,
  processEnvironment: NodeJS.ProcessEnv,
): LoadedTursoLiveEnvironment {
  const path = tursoLiveEnvironmentPath(repoRoot, environment);
  if (!existsSync(path)) {
    return { path, exists: false, env: { ...processEnvironment, ENV: environment } };
  }
  assertRegularEnvironmentFile(path);
  const fromFile = parse(readFileSync(path, "utf8"));
  return {
    path,
    exists: true,
    env: { ...fromFile, ...processEnvironment, ENV: environment },
  };
}

function validateOverrides(overrides: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`Environment value for ${key} must be single-line`);
    }
  }
}

function renderEnvironmentUpdate(
  original: string,
  overrides: Readonly<Record<string, string>>,
): string {
  const seen = new Set<string>();
  const lines = original.split("\n").map((line) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    const key = match?.[1];
    if (!key || !Object.hasOwn(overrides, key)) return line;
    seen.add(key);
    return `${key}=${overrides[key]}`;
  });
  const remaining = Object.entries(overrides).filter(([key]) => !seen.has(key));
  if (remaining.length > 0) {
    dropTrailingBlankLines(lines);
    lines.push("", "# Added by `tenkacloud turso-live`");
    for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  }
  // Trailing blank lines collapse into the single terminating newline below. Popping the empty
  // elements is what the old `.replace(/\n+$/u, "")` did, without that pattern's super-linear
  // backtracking on a long run of newlines (sonarjs/slow-regex).
  dropTrailingBlankLines(lines);
  return `${lines.join("\n")}\n`;
}

function dropTrailingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
}

/**
 * Update only the public Turso/AWS selectors. The existing file may contain secrets, so the
 * replacement is created beside it with owner-only permissions and atomically renamed.
 */
export function writeTursoLiveEnvironment(
  repoRoot: string,
  environment: string,
  overrides: Readonly<Record<string, string>>,
): string {
  validateOverrides(overrides);
  const path = tursoLiveEnvironmentPath(repoRoot, environment);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const original = existsSync(path)
    ? (() => {
        assertRegularEnvironmentFile(path);
        return readFileSync(path, "utf8");
      })()
    : "";
  const temporary = join(directory, `.env.tenkacloud-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, renderEnvironmentUpdate(original, overrides), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return path;
}

export function mergeSamlSsoFeature(raw: string | undefined): string {
  if (!raw?.trim()) return '{"samlSso":true}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CDK_PARAM_FEATURES must be a JSON object before enabling samlSso");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CDK_PARAM_FEATURES must be a JSON object before enabling samlSso");
  }
  return JSON.stringify({ ...(parsed as Readonly<Record<string, unknown>>), samlSso: true });
}
