import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalPlayState } from "../../../scripts/local-play/api-state";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import { startLocalPlayServer } from "../../../scripts/local-play/server";
import {
  parseLocalPlaySnapshot,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "../../../scripts/local-play/state-store";
import {
  localPlayDatabaseBackend,
  openLocalPlayStateStore,
} from "../../../scripts/local-play/state-store-factory";
import { openTursoLocalPlayStateStore } from "../../../scripts/local-play/turso-state-store";

const problem: ContainerProblem = {
  problemId: "hello-local",
  name: "Hello local",
  description: "Local persistence fixture",
  instructions: "Solve it",
  problemDir: "/tmp/hello-local",
  composePath: "/tmp/hello-local/compose.yaml",
  composeProjectName: "tc-hello-local",
  challengeEndpoints: { app: "http://127.0.0.1:18080" },
  verifyUrl: "http://127.0.0.1:18080/verify",
  secretEnv: [],
  scoring: {
    kind: "verify",
    points: 100,
    wrongAnswerPenalty: 10,
    hints: [{ id: "hint-1", content: "Look closer", penalty: 5 }],
  },
};

describe("local-play state store contract (#2633)", () => {
  it("should round-trip participant progress without persisting runtime ownership", () => {
    const source = createLocalPlayState({ problems: [problem], participantToken: "a".repeat(43) });
    const runtime = source.runtimes.get(problem.problemId);
    if (!runtime) throw new Error("fixture runtime missing");
    source.teamName = "Persisted team";
    runtime.solved.add(problem.problemId);
    runtime.revealedHints.set("hint-1", "2026-07-14T00:00:00.000Z");
    runtime.wrongCounts.set(problem.problemId, 2);
    runtime.score = 75;
    source.scoreEvents.push({
      jobId: "local-hello-local",
      problemId: problem.problemId,
      source: "flag",
      points: 100,
      result: "ok",
      occurredAt: "2026-07-14T00:00:00.000Z",
    });

    const snapshot = snapshotLocalPlayState(source);
    const target = createLocalPlayState({ problems: [problem], participantToken: "b".repeat(43) });
    restoreLocalPlayState(target, parseLocalPlaySnapshot(JSON.stringify(snapshot)));

    expect(target.teamName).toBe("Persisted team");
    expect(target.participantToken).toBe("b".repeat(43));
    expect(target.runtimes.get(problem.problemId)).toMatchObject({ score: 75 });
    expect([...(target.runtimes.get(problem.problemId)?.solved ?? [])]).toEqual([
      problem.problemId,
    ]);
    expect(target.scoreEvents).toEqual(source.scoreEvents);
    expect(target.lifecycle.statusOf(problem.problemId)).toBe("stopped");
  });

  it("should fail loudly on an unsupported or malformed snapshot", () => {
    expect(() => parseLocalPlaySnapshot('{"version":2}')).toThrow("version");
    expect(() => parseLocalPlaySnapshot('{"version":1,"teamName":3}')).toThrow("teamName");
  });

  it("should persist the default local backend in a private SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-sqlite-"));
    const databasePath = join(directory, "local-play.sqlite");
    const fixture = join(import.meta.dirname, "..", "fixtures", "local-play-sqlite-store.ts");
    const result = spawnSync("bun", [fixture, databasePath], { encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, teamName: "SQLite team" });
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("should reject a symbolic link instead of overwriting its SQLite target", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-sqlite-link-"));
    const target = join(directory, "target.sqlite");
    const databasePath = join(directory, "local-play.sqlite");
    writeFileSync(target, "owner data", { mode: 0o600 });
    symlinkSync(target, databasePath);
    const fixture = join(import.meta.dirname, "..", "fixtures", "local-play-sqlite-store.ts");

    const result = spawnSync("bun", [fixture, databasePath], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("regular file");
  });

  it("should open Turso only when the remote backend is explicitly selected", async () => {
    const sqlite = vi.fn(async () => ({
      description: "sqlite",
      load: async () => undefined,
      save: async () => {},
      close: async () => {},
    }));
    const turso = vi.fn(async () => ({
      description: "turso",
      load: async () => undefined,
      save: async () => {},
      close: async () => {},
    }));
    const paths = { databasePath: "/private/local-play.sqlite" } as Parameters<
      typeof openLocalPlayStateStore
    >[0];

    expect(localPlayDatabaseBackend({})).toBe("sqlite");
    await openLocalPlayStateStore(paths, {}, { sqlite, turso });
    expect(sqlite).toHaveBeenCalledWith(paths.databasePath);
    expect(turso).not.toHaveBeenCalled();

    await openLocalPlayStateStore(
      paths,
      {
        TENKACLOUD_LOCAL_DATABASE: "turso",
        TENKACLOUD_LOCAL_TURSO_URL: "https://example.turso.io",
        TENKACLOUD_LOCAL_TURSO_AUTH_TOKEN: "secret",
      },
      { sqlite, turso },
    );
    expect(turso).toHaveBeenCalledWith({ url: "https://example.turso.io", authToken: "secret" });
  });

  it("should reject unknown database backends", () => {
    expect(() => localPlayDatabaseBackend({ TENKACLOUD_LOCAL_DATABASE: "dynamodb" })).toThrow(
      "sqlite or turso",
    );
  });

  it("should reject unsafe Turso configuration before creating a client", async () => {
    await expect(
      openTursoLocalPlayStateStore({ url: "file:///tmp/local.db", authToken: "secret" }),
    ).rejects.toThrow("https:// or libsql://");
    await expect(
      openTursoLocalPlayStateStore({ url: "https://example.turso.io", authToken: "" }),
    ).rejects.toThrow("AUTH_TOKEN is required");
    await expect(
      openTursoLocalPlayStateStore({
        url: "https://user:secret@example.turso.io",
        authToken: "secret",
      }),
    ).rejects.toThrow("must not contain credentials");
  });

  it("should restore progress before serving and persist it before closing storage", async () => {
    const source = createLocalPlayState({ problems: [problem] });
    source.teamName = "Restored team";
    const snapshot = snapshotLocalPlayState(source);
    const save = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const server = await startLocalPlayServer(
      0,
      { problems: [problem] },
      {
        stateStore: {
          description: "test store",
          load: async () => snapshot,
          save,
          close,
        },
      },
    );
    try {
      expect(server.state.teamName).toBe("Restored team");
      server.state.teamName = "Saved team";
      await server.closeStateStore();
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ teamName: "Saved team" }));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
