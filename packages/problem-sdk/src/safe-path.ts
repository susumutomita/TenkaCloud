/**
 * [Problem SDK / Issue #2106 ← #2088] Safe path resolution + read-only filesystem
 * helpers for the offline pack validator.
 *
 * Owns the security-critical boundary check — "does this author-supplied path
 * stay strictly inside the pack root?" — independently of the validation
 * orchestration. It rejects absolute paths, `..` traversal, and symlinks that
 * escape the boundary (resolved on the longest existing prefix so a not-yet-
 * created artifact is still checked).
 *
 * Everything here is pure, read-only I/O — no writes, no network, no exec.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve `relative` against `base` and return the absolute path only when it
 * stays strictly inside `boundary` (defaults to `base`) — including after
 * symlink resolution of any existing prefix. Returns undefined when the input is
 * absolute, escapes via `..`, or resolves (via a symlink) outside the boundary.
 */
export function resolveInside(
  base: string,
  relative: string,
  boundary: string = base,
): string | undefined {
  if (relative.length === 0) return undefined;
  if (path.isAbsolute(relative)) return undefined;
  if (relative.split(/[\\/]/).includes("..")) return undefined;
  const joined = path.resolve(base, relative);
  if (!isInside(boundary, joined)) return undefined;
  // Resolve symlinks on the longest existing prefix and re-check containment.
  // Fail closed: if either realpath cannot be resolved, reject rather than fall
  // back to the unresolved path (a symlink whose real prefix escapes the pack
  // root must never be accepted).
  const real = realpathOfExistingPrefix(joined);
  const realBoundary = realpathOfExistingPrefix(boundary);
  if (real === undefined || realBoundary === undefined) return undefined;
  if (!isInside(realBoundary, real)) return undefined;
  return joined;
}

/**
 * `fs.realpathSync` requires the path to exist. For a possibly-missing artifact
 * we resolve symlinks on the longest existing ancestor, then re-append the
 * not-yet-created tail. This catches a symlinked directory that escapes root.
 *
 * Returns `undefined` (fail closed) when no ancestor exists or `realpathSync`
 * throws, so the caller rejects rather than trusting an unresolved path.
 */
function realpathOfExistingPrefix(target: string): string | undefined {
  let current = target;
  const tail: string[] = [];
  // Walk up until we hit a path that exists.
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined; // reached filesystem root without existing
    tail.unshift(path.basename(current));
    current = parent;
  }
  try {
    const real = fs.realpathSync(current);
    return tail.length > 0 ? path.join(real, ...tail) : real;
  } catch {
    return undefined;
  }
}

/** True when `child` is `parent` itself or strictly under it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Directory entry names directly under `dir`, sorted, dirs only. Missing dir → []. */
export function readDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
