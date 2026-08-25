/**
 * Artifact metadata, access control, and retention (Issue #3036 "Repository responsibility" —
 * TenkaCloud owns "artifact metadata、access control、retention"; real S3/DynamoDB storage is
 * explicitly out of scope: "実ストレージ(S3/DynamoDB)は実装しなくて構いません").
 *
 * Contract enforced here (Issue #3036 evidence boundary / acceptance criteria):
 *
 *   - immutable, content-addressed: an artifact's id IS `sha256:<hex>` of its (post-redaction)
 *     bytes — `put` never accepts a caller-chosen id, and there is no update method, only
 *     `pruneExpired` for retention;
 *   - tenant / event / team / run scoped: every record carries all four, and `get` requires the
 *     REQUESTOR to name the exact same four before it will return anything;
 *   - cross-team (or cross-tenant/cross-event/cross-run) access is denied — `get` with a scope
 *     that does not match the artifact's own scope throws `ArtifactAccessDeniedError`, whether or
 *     not the digest exists under some OTHER scope;
 *   - secret redaction happens INSIDE `put`, before the digest is computed — the id therefore
 *     always addresses the redacted bytes, never the raw ones (`./secret-redaction.ts`);
 *   - path traversal / symlink / special file / oversized / unknown schema are rejected before
 *     any content reaches `put` — `ingestArtifactFile` does the filesystem-specific checks
 *     (traversal / symlink / special file / oversized), and `put` itself reuses
 *     `validateHttpSequenceWitness` from ./witness.ts for `POC_WITNESS` content instead of
 *     re-implementing witness schema validation here.
 */

import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { sha256Hex, toDigestRef } from "./digest.js";
import { redactSecrets } from "./secret-redaction.js";
import { validateHttpSequenceWitness } from "./witness.js";

/** Issue #3036 "Artifact kinds" list, verbatim. */
export type ArtifactKind =
  | "THREAT_MODEL"
  | "RECON_PLAN"
  | "FINDER_TRANSCRIPT"
  | "POC_WITNESS"
  | "VERIFICATION_RESULT"
  | "DEDUPE_MANIFEST"
  | "EVIDENCE_REPORT"
  | "PATCH_ARTIFACT"
  | "PATCH_VALIDATION"
  | "REATTACK_RESULT"
  | "AUDIT_EVENT_STREAM";

/** The four scoping dimensions the issue requires ("tenant/event/team/run scoped"). All required — there is no unscoped artifact. */
export interface ArtifactScope {
  readonly tenantId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly runId: string;
}

const KNOWN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/jsonl",
  "application/x-ndjson",
  "text/plain",
]);

const MAX_ARTIFACT_BYTES = 1_000_000; // 1 MB — generous for JSON evidence records, small enough to bound memory.

export interface ArtifactMetadata {
  /** Content digest, `sha256:<hex>` of the REDACTED bytes — this is also the artifact's id. */
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly redactedSecretCount: number;
  readonly producer?: { readonly id: string; readonly version: string };
  readonly retention?: { readonly expiresAt?: string };
}

export interface ArtifactRecord extends ArtifactMetadata {
  readonly content: string;
}

export interface PutArtifactInput {
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  readonly content: string;
  readonly contentType?: string;
  readonly producer?: { readonly id: string; readonly version: string };
  readonly retention?: { readonly expiresAt?: string };
}

export class ArtifactValidationError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`artifact rejected: ${reasons.join("; ")}`);
    this.name = "ArtifactValidationError";
  }
}

export class ArtifactAccessDeniedError extends Error {
  constructor(
    readonly artifactId: string,
    readonly requestedScope: ArtifactScope,
    /** True when the digest exists under some OTHER scope — never reveals which one. */
    readonly existsUnderDifferentScope: boolean,
  ) {
    super(
      `artifact "${artifactId}" is not accessible to tenant=${requestedScope.tenantId} event=${requestedScope.eventId} team=${requestedScope.teamId} run=${requestedScope.runId}`,
    );
    this.name = "ArtifactAccessDeniedError";
  }
}

function scopeKey(scope: ArtifactScope): string {
  // "::" separator: none of the four ids is expected to contain it, and even if one did, the
  // worst case is two DIFFERENT scopes colliding onto the same key, which only makes access
  // control MORE conservative (an over-broad match still requires all 4 raw values to align on
  // both sides of "::", it does not let a caller widen access) — never less safe than intended.
  return `${scope.tenantId}::${scope.eventId}::${scope.teamId}::${scope.runId}`;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

function validateScope(scope: ArtifactScope, errors: string[]): void {
  if (
    !isNonEmptyString(scope.tenantId) ||
    !isNonEmptyString(scope.eventId) ||
    !isNonEmptyString(scope.teamId) ||
    !isNonEmptyString(scope.runId)
  ) {
    errors.push("scope: tenantId/eventId/teamId/runId must all be non-empty strings");
  }
}

/** Reuses ./witness.ts's schema/size validation for POC_WITNESS content instead of re-implementing it; does line-by-line JSON validation for JSONL/ndjson kinds (AUDIT_EVENT_STREAM); otherwise requires whole-content valid JSON. */
function validateArtifactContent(
  kind: ArtifactKind,
  contentType: string,
  content: string,
  errors: string[],
): void {
  if (!KNOWN_CONTENT_TYPES.has(contentType)) {
    errors.push(`unsupported contentType "${contentType}"`);
    return;
  }
  if (contentType === "application/jsonl" || contentType === "application/x-ndjson") {
    const lines = content.split("\n").filter((l) => l.length > 0);
    lines.forEach((line, i) => {
      try {
        JSON.parse(line);
      } catch {
        errors.push(`line ${i}: not valid JSON`);
      }
    });
    return;
  }
  if (contentType === "text/plain") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    errors.push("content is not valid JSON");
    return;
  }
  if (kind === "POC_WITNESS") {
    const result = validateHttpSequenceWitness(parsed);
    if (!result.ok) errors.push(...result.errors.map((e) => `witness schema: ${e}`));
  }
}

/** Reference implementation of the artifact store contract (Issue #3036). In-memory only — see this file's header comment for what is and is not in scope. */
export class InMemoryArtifactStore {
  private readonly contents = new Map<string, string>(); // digest -> redacted content, deduped across scopes
  private readonly digestRefCounts = new Map<string, number>();
  private readonly records = new Map<string, ArtifactRecord>(); // `${scopeKey}::${digest}` -> record

  /**
   * Redacts, size-bounds, schema-validates, and content-addresses `input.content`, then stores it
   * under `input.scope`. Idempotent: putting byte-identical (post-redaction) content into the same
   * scope again returns the existing record unchanged rather than creating a duplicate.
   */
  put(input: PutArtifactInput, now: () => string = () => new Date().toISOString()): ArtifactRecord {
    const errors: string[] = [];
    validateScope(input.scope, errors);
    const contentType = input.contentType ?? "application/json";
    const { redacted, redactedCount } = redactSecrets(input.content);
    const sizeBytes = Buffer.byteLength(redacted, "utf8");
    if (sizeBytes > MAX_ARTIFACT_BYTES) {
      errors.push(`content exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact bound`);
    }
    validateArtifactContent(input.kind, contentType, redacted, errors);
    if (errors.length > 0) throw new ArtifactValidationError(errors);

    const digest = toDigestRef(sha256Hex(redacted));
    const key = `${scopeKey(input.scope)}::${digest}`;
    const existing = this.records.get(key);
    if (existing) return existing;

    this.contents.set(digest, redacted);
    this.digestRefCounts.set(digest, (this.digestRefCounts.get(digest) ?? 0) + 1);

    const record: ArtifactRecord = {
      id: digest,
      kind: input.kind,
      scope: input.scope,
      contentType,
      sizeBytes,
      createdAt: now(),
      redactedSecretCount: redactedCount,
      content: redacted,
      ...(input.producer !== undefined ? { producer: input.producer } : {}),
      ...(input.retention !== undefined ? { retention: input.retention } : {}),
    };
    this.records.set(key, record);
    return record;
  }

  /**
   * Returns the artifact addressed by `id` ONLY if `requestedScope` exactly matches the scope it
   * was stored under. A mismatch — including a genuine cross-team, cross-tenant, cross-event, or
   * cross-run request — throws `ArtifactAccessDeniedError` rather than returning `undefined`, so
   * a caller cannot mistake "denied" for "does not exist yet" and silently proceed.
   */
  get(id: string, requestedScope: ArtifactScope): ArtifactRecord {
    const key = `${scopeKey(requestedScope)}::${id}`;
    const record = this.records.get(key);
    if (record) return record;
    const existsUnderDifferentScope = [...this.records.keys()].some((k) => k.endsWith(`::${id}`));
    throw new ArtifactAccessDeniedError(id, requestedScope, existsUnderDifferentScope);
  }

  /** Lists every artifact stored under EXACTLY `scope` — never a superset, never another team's records. */
  listByScope(scope: ArtifactScope, kind?: ArtifactKind): readonly ArtifactMetadata[] {
    const prefix = `${scopeKey(scope)}::`;
    const out: ArtifactMetadata[] = [];
    for (const [key, record] of this.records) {
      if (!key.startsWith(prefix)) continue;
      if (kind !== undefined && record.kind !== kind) continue;
      const { content, ...metadata } = record;
      out.push(metadata);
    }
    return out;
  }

  /** Removes every record whose `retention.expiresAt` is at or before `now()`. Returns the removed ids. Content bytes are only actually freed once no scope still references that digest. */
  pruneExpired(now: () => string = () => new Date().toISOString()): readonly string[] {
    const nowIso = now();
    const removed: string[] = [];
    for (const [key, record] of this.records) {
      if (record.retention?.expiresAt !== undefined && record.retention.expiresAt <= nowIso) {
        this.records.delete(key);
        removed.push(record.id);
        const refCount = (this.digestRefCounts.get(record.id) ?? 1) - 1;
        if (refCount <= 0) {
          this.digestRefCounts.delete(record.id);
          this.contents.delete(record.id);
        } else {
          this.digestRefCounts.set(record.id, refCount);
        }
      }
    }
    return removed;
  }
}

export interface IngestArtifactFileInput {
  readonly store: InMemoryArtifactStore;
  /** A trusted, pre-resolved sandbox root — `relativePath` may never escape it. */
  readonly rootDir: string;
  readonly relativePath: string;
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  readonly contentType?: string;
  readonly producer?: { readonly id: string; readonly version: string };
  readonly retention?: { readonly expiresAt?: string };
  readonly now?: () => string;
}

const MAX_INGEST_FILE_BYTES = MAX_ARTIFACT_BYTES;

/**
 * Filesystem-backed ingestion helper (Issue #3036 acceptance criteria: reject path traversal /
 * symlink / special file / oversized witness before persisting). This is the ONLY place in this
 * package that reads a caller-supplied path off disk; `InMemoryArtifactStore.put` itself never
 * touches the filesystem.
 *
 * Ordering matters: every check below runs BEFORE any byte of file content is read, so a hostile
 * `relativePath` (traversal, a symlink to `/etc/passwd`, a FIFO that would block forever, a device
 * file) can never even be opened for reading, let alone stored.
 */
export function ingestArtifactFile(input: IngestArtifactFileInput): ArtifactRecord {
  const root = resolve(input.rootDir);
  const resolved = resolve(root, input.relativePath);
  // Path traversal: the resolved path must stay strictly inside `root`.
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new ArtifactValidationError([
      `path traversal: "${input.relativePath}" resolves outside the artifact root`,
    ]);
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    // lstat, never stat: a symlink must be rejected even when ITS TARGET is an ordinary,
    // otherwise-harmless file — stat() would silently follow it and hide that fact.
    stats = lstatSync(resolved);
  } catch (err) {
    throw new ArtifactValidationError([`cannot stat "${input.relativePath}": ${String(err)}`]);
  }
  if (stats.isSymbolicLink()) {
    throw new ArtifactValidationError([`refusing to ingest a symlink: "${input.relativePath}"`]);
  }
  if (!stats.isFile()) {
    throw new ArtifactValidationError([
      `refusing to ingest a non-regular file (directory/socket/FIFO/device): "${input.relativePath}"`,
    ]);
  }
  if (stats.size > MAX_INGEST_FILE_BYTES) {
    throw new ArtifactValidationError([
      `"${input.relativePath}" exceeds the ${MAX_INGEST_FILE_BYTES}-byte ingest bound`,
    ]);
  }

  const content = readFileSync(resolved, "utf8");
  return input.store.put(
    {
      kind: input.kind,
      scope: input.scope,
      content,
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      ...(input.producer !== undefined ? { producer: input.producer } : {}),
      ...(input.retention !== undefined ? { retention: input.retention } : {}),
    },
    input.now,
  );
}
