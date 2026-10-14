import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", "dist"]);

/**
 * Compute a deterministic content digest of a pack directory: a hex SHA-256 over
 * a canonical encoding where every included file, in sorted POSIX-relative-path
 * order, contributes its length-prefixed path and its length-prefixed bytes. The
 * walk excludes `.git`, `node_modules`, `dist`, hidden (dot-prefixed) entries, and
 * symlinks (never followed or counted). Identical content always yields an
 * identical digest, independent of iteration order or timestamps.
 * includeAllFiles binds every byte of downloaded runtime trees and rejects links.
 */
export function computeContentDigest(dir: string, includeAllFiles = false): string {
  const root = path.resolve(dir);
  if (!isExistingDirectory(root)) {
    // A missing pack directory has no bytes — hash the empty input so the result
    // is still deterministic rather than throwing.
    return createHash("sha256").digest("hex");
  }
  const files = collectFiles(root, root, includeAllFiles).sort((a, b) =>
    a.relPath < b.relPath ? -1 : 1,
  );
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relPath, "utf-8");
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    const content = fs.readFileSync(file.absPath);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** One included pack file: its pack-relative POSIX path and its absolute path. */
export interface CollectedPackFile {
  readonly relPath: string;
  readonly absPath: string;
}

/**
 * Walk a pack directory with the digest's exclusion rules (`.git` /
 * `node_modules` / `dist` / hidden entries / symlinks), unsorted. Exported (via
 * `/internal` only) for the Core snapshot installer, so the copied file set is
 * EXACTLY the digested file set — one walk implementation, no drift (#2866).
 */
export function collectPackFiles(dir: string): CollectedPackFile[] {
  const root = path.resolve(dir);
  return collectFiles(root, root);
}

function collectFiles(root: string, dir: string, includeAllFiles = false): CollectedPackFile[] {
  const out: CollectedPackFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!includeAllFiles && isExcludedName(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      if (includeAllFiles) throw new Error(`Catalog contains a symbolic link: ${entry.name}`);
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(root, abs, includeAllFiles));
    } else if (entry.isFile()) {
      out.push({ relPath: toPosixRelative(root, abs), absPath: abs });
    } else if (includeAllFiles) throw new Error(`Unsupported catalog file: ${abs}`);
  }
  return out;
}

function isExcludedName(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIR_NAMES.has(name);
}

function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
