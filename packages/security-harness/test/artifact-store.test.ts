import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactAccessDeniedError,
  ArtifactValidationError,
  InMemoryArtifactStore,
  ingestArtifactFile,
} from "../src/artifact-store.js";
import { sha256Hex, toDigestRef } from "../src/digest.js";

const TEAM_A_SCOPE = { tenantId: "tenant-1", eventId: "event-1", teamId: "team-a", runId: "run-1" };
const TEAM_B_SCOPE = { tenantId: "tenant-1", eventId: "event-1", teamId: "team-b", runId: "run-2" };

const FIXED_CLOCK = (): string => "2026-01-01T00:00:00.000Z";

describe("InMemoryArtifactStore.put: content addressing", () => {
  it("should content-address by the SHA-256 of the (post-redaction) bytes, not a caller-chosen id", () => {
    const store = new InMemoryArtifactStore();
    const content = JSON.stringify({ note: "no secrets here" });
    const record = store.put(
      { kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content },
      FIXED_CLOCK,
    );
    expect(record.id).toBe(toDigestRef(sha256Hex(content)));
  });

  it("should compute the digest from the REDACTED bytes, so the id never matches the raw secret-bearing content", () => {
    const store = new InMemoryArtifactStore();
    const raw = JSON.stringify({ headers: { authorization: "token-a" } });
    const record = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: raw });
    expect(record.id).not.toBe(toDigestRef(sha256Hex(raw)));
    expect(record.content).not.toContain("token-a");
    expect(record.id).toBe(toDigestRef(sha256Hex(record.content)));
  });

  it("should be idempotent for byte-identical content in the same scope", () => {
    const store = new InMemoryArtifactStore();
    const content = JSON.stringify({ a: 1 });
    const first = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content }, FIXED_CLOCK);
    const second = store.put(
      { kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content },
      () => "2099-01-01T00:00:00.000Z",
    );
    expect(second).toEqual(first);
    expect(second.createdAt).toBe(FIXED_CLOCK());
  });

  it("should reject an incomplete scope (missing tenant/event/team/run)", () => {
    const store = new InMemoryArtifactStore();
    expect(() =>
      store.put({
        kind: "EVIDENCE_REPORT",
        scope: { ...TEAM_A_SCOPE, teamId: "" },
        content: "{}",
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject an unknown content type", () => {
    const store = new InMemoryArtifactStore();
    expect(() =>
      store.put({
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
        content: "<xml/>",
        contentType: "application/xml",
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject content that is not valid JSON for a JSON-typed artifact (unknown schema)", () => {
    const store = new InMemoryArtifactStore();
    expect(() =>
      store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{not json" }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject an oversized artifact", () => {
    const store = new InMemoryArtifactStore();
    const huge = JSON.stringify({ blob: "x".repeat(2_000_000) });
    expect(() =>
      store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: huge }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reuse ./witness.ts's schema validator for POC_WITNESS content instead of accepting arbitrary JSON", () => {
    const store = new InMemoryArtifactStore();
    const malformedWitness = JSON.stringify({ type: "http-sequence", witnessId: "w-1" }); // missing focusArea/steps
    expect(() =>
      store.put({ kind: "POC_WITNESS", scope: TEAM_A_SCOPE, content: malformedWitness }),
    ).toThrow(ArtifactValidationError);

    const validWitness = JSON.stringify({
      type: "http-sequence",
      witnessId: "w-1",
      focusArea: "documents-idor",
      steps: [{ method: "GET", path: "/documents/doc-b1", expectStatus: 200 }],
    });
    expect(() =>
      store.put({ kind: "POC_WITNESS", scope: TEAM_A_SCOPE, content: validWitness }),
    ).not.toThrow();
  });

  it("should accept application/jsonl content validated line by line", () => {
    const store = new InMemoryArtifactStore();
    const jsonl = `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ b: 2 })}\n`;
    const record = store.put({
      kind: "AUDIT_EVENT_STREAM",
      scope: TEAM_A_SCOPE,
      content: jsonl,
      contentType: "application/jsonl",
    });
    expect(record.contentType).toBe("application/jsonl");
  });

  it("should report the correct 0-indexed line number for a single malformed line among several JSONL lines", () => {
    const store = new InMemoryArtifactStore();
    // Line 0 and line 2 are valid JSON; only line 1 ("not-json") is malformed.
    const content = `${JSON.stringify({ a: 1 })}\nnot-json\n${JSON.stringify({ b: 2 })}\n`;
    try {
      store.put({
        kind: "AUDIT_EVENT_STREAM",
        scope: TEAM_A_SCOPE,
        content,
        contentType: "application/jsonl",
      });
      expect.fail("expected put() to throw ArtifactValidationError for a malformed JSONL line");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      expect((error as ArtifactValidationError).reasons).toEqual(["line 1: not valid JSON"]);
    }
  });

  it("should accept non-JSON content for text/plain (no whole-content JSON validation applies)", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({
      kind: "EVIDENCE_REPORT",
      scope: TEAM_A_SCOPE,
      content: "plain text notes, deliberately not JSON at all",
      contentType: "text/plain",
    });
    expect(record.contentType).toBe("text/plain");
    expect(record.content).toBe("plain text notes, deliberately not JSON at all");
  });

  it("should attach an optional producer to the stored record when supplied", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({
      kind: "EVIDENCE_REPORT",
      scope: TEAM_A_SCOPE,
      content: "{}",
      producer: { id: "harness-cli", version: "1.2.3" },
    });
    expect(record.producer).toEqual({ id: "harness-cli", version: "1.2.3" });
  });
});

describe("InMemoryArtifactStore.get: cross-team access is denied", () => {
  it("should let a team read its own artifact", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{}" });
    expect(store.get(record.id, TEAM_A_SCOPE)).toEqual(record);
  });

  it("should deny a DIFFERENT team access to the same artifact id, and flag that it exists elsewhere", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{}" });
    try {
      store.get(record.id, TEAM_B_SCOPE);
      expect.fail("expected get() to throw ArtifactAccessDeniedError for a cross-team request");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactAccessDeniedError);
      expect((error as ArtifactAccessDeniedError).existsUnderDifferentScope).toBe(true);
    }
  });

  it("should deny access with the same message shape for a genuinely unknown id (no existence leak difference in the thrown type)", () => {
    const store = new InMemoryArtifactStore();
    try {
      store.get("sha256:doesnotexist", TEAM_A_SCOPE);
      expect.fail("expected get() to throw for an unknown id");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactAccessDeniedError);
      expect((error as ArtifactAccessDeniedError).existsUnderDifferentScope).toBe(false);
    }
  });

  it("should also deny access across tenant/event/run boundaries, not just team", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{}" });
    expect(() => store.get(record.id, { ...TEAM_A_SCOPE, tenantId: "tenant-2" })).toThrow(
      ArtifactAccessDeniedError,
    );
    expect(() => store.get(record.id, { ...TEAM_A_SCOPE, eventId: "event-2" })).toThrow(
      ArtifactAccessDeniedError,
    );
    expect(() => store.get(record.id, { ...TEAM_A_SCOPE, runId: "run-9" })).toThrow(
      ArtifactAccessDeniedError,
    );
  });
});

describe("InMemoryArtifactStore.listByScope", () => {
  it("should list only records under the exact requested scope, and never include raw content in the metadata", () => {
    const store = new InMemoryArtifactStore();
    store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: '{"n":1}' });
    store.put({ kind: "PATCH_VALIDATION", scope: TEAM_A_SCOPE, content: '{"n":2}' });
    store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_B_SCOPE, content: '{"n":3}' });

    const teamAArtifacts = store.listByScope(TEAM_A_SCOPE);
    expect(teamAArtifacts).toHaveLength(2);
    expect(teamAArtifacts.every((a) => !("content" in a))).toBe(true);

    const teamBArtifacts = store.listByScope(TEAM_B_SCOPE);
    expect(teamBArtifacts).toHaveLength(1);
  });

  it("should filter by kind when given", () => {
    const store = new InMemoryArtifactStore();
    store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{}" });
    store.put({ kind: "PATCH_VALIDATION", scope: TEAM_A_SCOPE, content: '{"x":1}' });
    expect(store.listByScope(TEAM_A_SCOPE, "PATCH_VALIDATION")).toHaveLength(1);
  });
});

describe("InMemoryArtifactStore.pruneExpired: retention", () => {
  it("should remove artifacts whose retention has expired and make them inaccessible afterward", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put(
      {
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
        content: "{}",
        retention: { expiresAt: "2026-01-01T00:00:00.000Z" },
      },
      () => "2025-12-31T00:00:00.000Z",
    );
    expect(store.get(record.id, TEAM_A_SCOPE)).toBeDefined();

    const removed = store.pruneExpired(() => "2026-06-01T00:00:00.000Z");
    expect(removed).toContain(record.id);
    expect(() => store.get(record.id, TEAM_A_SCOPE)).toThrow(ArtifactAccessDeniedError);
  });

  it("should not remove artifacts with no retention or a future expiry", () => {
    const store = new InMemoryArtifactStore();
    const noRetention = store.put({ kind: "EVIDENCE_REPORT", scope: TEAM_A_SCOPE, content: "{}" });
    const futureRetention = store.put({
      kind: "PATCH_VALIDATION",
      scope: TEAM_A_SCOPE,
      content: '{"x":1}',
      retention: { expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    const removed = store.pruneExpired(() => "2026-06-01T00:00:00.000Z");
    expect(removed).toHaveLength(0);
    expect(store.get(noRetention.id, TEAM_A_SCOPE)).toBeDefined();
    expect(store.get(futureRetention.id, TEAM_A_SCOPE)).toBeDefined();
  });

  it("should default to the system clock when no clock is injected, so a far-past expiry is still pruned", () => {
    const store = new InMemoryArtifactStore();
    const record = store.put({
      kind: "EVIDENCE_REPORT",
      scope: TEAM_A_SCOPE,
      content: "{}",
      retention: { expiresAt: "1970-01-01T00:00:00.000Z" },
    });
    const removed = store.pruneExpired();
    expect(removed).toContain(record.id);
    expect(() => store.get(record.id, TEAM_A_SCOPE)).toThrow(ArtifactAccessDeniedError);
  });

  it("should keep content bytes alive for a surviving scope after an identical-content record in ANOTHER scope expires, and only free them once every referencing scope has expired", () => {
    const store = new InMemoryArtifactStore();
    const content = JSON.stringify({ shared: "identical bytes, two independent scopes" });

    const teamARecord = store.put(
      {
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
        content,
        retention: { expiresAt: "2026-01-01T00:00:00.000Z" },
      },
      FIXED_CLOCK,
    );
    const teamBRecord = store.put(
      {
        kind: "EVIDENCE_REPORT",
        scope: TEAM_B_SCOPE,
        content,
        retention: { expiresAt: "2027-01-01T00:00:00.000Z" },
      },
      FIXED_CLOCK,
    );
    // Byte-identical (post-redaction) content under two different scopes content-addresses to the
    // same digest — this is the whole point of the scenario: one shared content blob, two scopes.
    expect(teamBRecord.id).toBe(teamARecord.id);

    // Expire only team A's record. Team B's record on the SAME digest is still live, so the
    // content bytes must NOT be freed yet.
    const firstRemoved = store.pruneExpired(() => "2026-06-01T00:00:00.000Z");
    expect(firstRemoved).toEqual([teamARecord.id]);
    expect(() => store.get(teamARecord.id, TEAM_A_SCOPE)).toThrow(ArtifactAccessDeniedError);

    const stillReadable = store.get(teamBRecord.id, TEAM_B_SCOPE);
    expect(stillReadable.content).toBe(teamARecord.content);

    // Now expire team B's record too — the last reference to that digest — and the bytes are
    // finally released (also reflected in it becoming inaccessible).
    const secondRemoved = store.pruneExpired(() => "2027-06-01T00:00:00.000Z");
    expect(secondRemoved).toEqual([teamBRecord.id]);
    expect(() => store.get(teamBRecord.id, TEAM_B_SCOPE)).toThrow(ArtifactAccessDeniedError);
  });
});

describe("ingestArtifactFile: filesystem ingestion safety", () => {
  const tempRoots: string[] = [];

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "security-harness-artifact-test-"));
    tempRoots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("should ingest a normal, in-bounds regular file", () => {
    const root = makeRoot();
    writeFileSync(join(root, "evidence.json"), JSON.stringify({ note: "fine" }));
    const store = new InMemoryArtifactStore();
    const record = ingestArtifactFile({
      store,
      rootDir: root,
      relativePath: "evidence.json",
      kind: "EVIDENCE_REPORT",
      scope: TEAM_A_SCOPE,
      now: FIXED_CLOCK,
    });
    expect(record.content).toContain("fine");
  });

  it("should throw ArtifactValidationError naming the participant-supplied relativePath when the target cannot be stat'd at all (e.g. it does not exist)", () => {
    const root = makeRoot();
    const store = new InMemoryArtifactStore();
    // In-bounds path (so the traversal check passes and we actually reach lstatSync), but nothing
    // exists there — lstatSync itself must throw, distinct from the symlink-rejection branch below.
    try {
      ingestArtifactFile({
        store,
        rootDir: root,
        relativePath: "does-not-exist.json",
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
      });
      expect.fail("expected ingestArtifactFile() to throw for a path that cannot be stat'd");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      expect((error as ArtifactValidationError).reasons[0]).toContain("does-not-exist.json");
    }
  });

  it("should forward an explicit contentType, producer, and retention through to the stored record", () => {
    const root = makeRoot();
    writeFileSync(join(root, "notes.txt"), "plain text, deliberately not JSON at all");
    const store = new InMemoryArtifactStore();
    const record = ingestArtifactFile({
      store,
      rootDir: root,
      relativePath: "notes.txt",
      kind: "EVIDENCE_REPORT",
      scope: TEAM_A_SCOPE,
      contentType: "text/plain",
      producer: { id: "harness-cli", version: "1.2.3" },
      retention: { expiresAt: "2099-01-01T00:00:00.000Z" },
      now: FIXED_CLOCK,
    });
    expect(record.contentType).toBe("text/plain");
    expect(record.content).toBe("plain text, deliberately not JSON at all");
    expect(record.producer).toEqual({ id: "harness-cli", version: "1.2.3" });
    expect(record.retention).toEqual({ expiresAt: "2099-01-01T00:00:00.000Z" });
  });

  it("should reject a path that traverses outside the artifact root, even before checking whether the target exists", () => {
    const root = makeRoot();
    mkdirSync(join(root, "sub"));
    const store = new InMemoryArtifactStore();
    // The traversal check runs on the RESOLVED PATH alone, before any stat/read — this must be
    // rejected whether or not something actually exists at the escaped location.
    expect(() =>
      ingestArtifactFile({
        store,
        rootDir: join(root, "sub"),
        relativePath: "../../etc/passwd",
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject a symlink even when its target is an ordinary file", () => {
    const root = makeRoot();
    const targetPath = join(root, "real.json");
    writeFileSync(targetPath, JSON.stringify({ ok: true }));
    const linkPath = join(root, "link.json");
    symlinkSync(targetPath, linkPath);
    const store = new InMemoryArtifactStore();
    expect(() =>
      ingestArtifactFile({
        store,
        rootDir: root,
        relativePath: "link.json",
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject a non-regular file (e.g. a directory) passed as the target", () => {
    const root = makeRoot();
    mkdirSync(join(root, "a-directory"));
    const store = new InMemoryArtifactStore();
    expect(() =>
      ingestArtifactFile({
        store,
        rootDir: root,
        relativePath: "a-directory",
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("should reject an oversized file before reading its content", () => {
    const root = makeRoot();
    writeFileSync(join(root, "huge.json"), "x".repeat(2_000_000));
    const store = new InMemoryArtifactStore();
    expect(() =>
      ingestArtifactFile({
        store,
        rootDir: root,
        relativePath: "huge.json",
        kind: "EVIDENCE_REPORT",
        scope: TEAM_A_SCOPE,
        contentType: "text/plain",
      }),
    ).toThrow(ArtifactValidationError);
  });
});
