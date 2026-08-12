import { isExactSemver } from "../../packages/problem-sdk/src/semver-range";

/**
 * Generic JSON field parsers for the release manifest (#3024). This module owns the
 * value-level vocabulary — exact objects that reject unknown keys, non-empty strings,
 * HTTPS URLs, real calendar instants — while manifest.ts owns the domain shapes and
 * cross-field release rules built on top of it. Every failure names the exact JSON
 * path; nothing here coerces or silently strips.
 */

export type UnknownRecord = Record<string, unknown>;

const RFC_3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

export function fail(path: string, message: string): never {
  throw new Error(`Invalid release manifest at ${path}: ${message}`);
}

export function recordAt(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as UnknownRecord;
}

export function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = recordAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown property");
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "required property is missing");
  }
  return record;
}

export function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

export function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

export function stringMatching(
  value: unknown,
  path: string,
  pattern: RegExp,
  description: string,
): string {
  const parsed = stringAt(value, path);
  if (!pattern.test(parsed)) fail(path, description);
  return parsed;
}

export function exactSemverAt(value: unknown, path: string): string {
  const parsed = stringAt(value, path);
  if (!isExactSemver(parsed)) fail(path, "expected an exact semantic version");
  return parsed;
}

export function literalAt<const T extends string | number>(
  value: unknown,
  path: string,
  literal: T,
): T {
  if (value !== literal) fail(path, `expected ${JSON.stringify(literal)}`);
  return literal;
}

export function enumAt<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function httpsUrlAt(value: unknown, path: string): string {
  const parsed = stringAt(value, path);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    fail(path, "expected an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") fail(path, "expected an absolute HTTPS URL");
  return parsed;
}

export function strictDateTimeAt(value: unknown, path: string): string {
  const parsed = stringAt(value, path);
  const match = RFC_3339_DATE_TIME.exec(parsed);
  if (!match) fail(path, "expected an RFC 3339 date-time including a timezone");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validCalendarDate =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
  if (!validCalendarDate || Number.isNaN(Date.parse(parsed))) {
    fail(path, "date-time is not a real calendar instant");
  }
  return parsed;
}

export function uniqueStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(path, `duplicate value ${JSON.stringify(value)}`);
    seen.add(value);
  }
}
