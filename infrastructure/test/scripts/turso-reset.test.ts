import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../../../scripts/cli/process";
import {
  resolveTursoResetTarget,
  runTursoReset,
  type TursoResetDeps,
} from "../../../scripts/ops/turso-reset";

/**
 * `make turso-reset` (2026-07-21 追加) の contract を pin する。
 * destructive コマンドなので「実行してよい条件」の分岐 (backend guard / confirm /
 * 非対話 --yes) と、削除対象の列挙がハードコードでなく sqlite_master 由来である
 * ことをテストで固定する。
 */

const VALID_ENV: NodeJS.ProcessEnv = {
  CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
  CDK_PARAM_TURSO_DATABASE_URL: "https://example.turso.io",
  CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/test/turso/auth-token",
};

function textRow(value: string) {
  return [{ type: "text", value }];
}

function okResult(rows: unknown[] = [], affected = 0) {
  return {
    type: "ok",
    response: { result: { rows, affected_row_count: affected } },
  };
}

function makeProcessRunner(token = "secret-token"): ProcessRunner {
  return {
    run: vi.fn().mockReturnValue({ status: 0, stdout: `${token}\n`, stderr: "" }),
  };
}

interface HttpCall {
  readonly url: string;
  readonly authToken: string;
  readonly statements: readonly string[];
}

/**
 * pipeline fake: 呼び出し順に応答を返し、投げられた SQL を記録する。
 * 1 回目 = table 列挙、 2 回目 = deployments count、 3 回目 = DELETE batch を想定。
 */
function makeHttp(responses: unknown[][]) {
  const calls: HttpCall[] = [];
  let index = 0;
  const httpPost = vi.fn(async (url: string, authToken: string, body: unknown) => {
    const requests = (body as { requests: { type: string; stmt?: { sql: string } }[] }).requests;
    calls.push({
      url,
      authToken,
      statements: requests.filter((r) => r.type === "execute").map((r) => r.stmt?.sql ?? ""),
    });
    const results = responses[index] ?? [];
    index += 1;
    return { results: [...results, { type: "ok", response: { type: "close" } }] };
  });
  return { httpPost, calls };
}

function makeDeps(over: Partial<TursoResetDeps> = {}): TursoResetDeps & {
  logs: string[];
} {
  const logs: string[] = [];
  return {
    env: VALID_ENV,
    environment: "test",
    processRunner: makeProcessRunner(),
    httpPost: vi.fn(async () => ({ results: [] })),
    confirm: vi.fn(async () => true),
    log: (message: string) => logs.push(message),
    interactive: true,
    assumeYes: false,
    logs,
    ...over,
  };
}

describe("resolveTursoResetTarget", () => {
  it("should accept a valid turso environment", () => {
    const resolved = resolveTursoResetTarget(VALID_ENV);
    expect(resolved).toMatchObject({
      ok: true,
      target: {
        databaseUrl: "https://example.turso.io",
        parameterName: "/TenkaCloud/test/turso/auth-token",
      },
    });
  });

  it("should reject when the backend is not turso (dynamodb 環境での誤爆防止)", () => {
    const resolved = resolveTursoResetTarget({
      ...VALID_ENV,
      CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.errors.join("\n")).toContain("turso ではありません");
  });

  it("should reject a missing database URL and parameter name with actionable errors", () => {
    const resolved = resolveTursoResetTarget({ CDK_PARAM_CONTROL_DATA_BACKEND: "turso" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.errors.some((e) => e.includes("TURSO_DATABASE_URL"))).toBe(true);
      expect(resolved.errors.some((e) => e.includes("PARAMETER_NAME"))).toBe(true);
    }
  });
});

describe("runTursoReset", () => {
  it("should list tables from sqlite_master, warn on live deployments, and delete every row", async () => {
    const { httpPost, calls } = makeHttp([
      [okResult([textRow("control_data_migrations"), textRow("deployments"), textRow("events")])],
      [okResult([[{ type: "integer", value: "2" }]])],
      [okResult([], 2), okResult([], 5)],
    ]);
    const deps = makeDeps({ httpPost });
    const code = await runTursoReset(deps);
    expect(code).toBe(0);
    // 1 回目: sqlite_master 列挙 / 2 回目: deployments count / 3 回目: DELETE batch。
    expect(calls[0]?.statements[0]).toContain("sqlite_master");
    expect(calls[0]?.url).toBe("https://example.turso.io/v2/pipeline");
    expect(calls[0]?.authToken).toBe("secret-token");
    expect(calls[2]?.statements).toEqual(['DELETE FROM "deployments"', 'DELETE FROM "events"']);
    // control_data_migrations は削除しない。
    expect(calls[2]?.statements.join()).not.toContain("control_data_migrations");
    expect(deps.logs.join("\n")).toContain("deployments に 2 行残っています");
    expect(deps.logs.join("\n")).toContain("events: 5 行削除");
    expect(deps.logs.join("\n")).toContain("初期化しました");
  });

  it("should abort without deleting when the operator declines the confirm", async () => {
    const { httpPost, calls } = makeHttp([[okResult([textRow("events")])]]);
    const deps = makeDeps({ httpPost, confirm: vi.fn(async () => false) });
    const code = await runTursoReset(deps);
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(deps.logs.join("\n")).toContain("中止しました");
  });

  it("should refuse in a non-interactive session unless --yes is passed", async () => {
    const { httpPost, calls } = makeHttp([[okResult([textRow("events")])]]);
    const deps = makeDeps({ httpPost, interactive: false });
    expect(await runTursoReset(deps)).toBe(1);
    expect(calls).toHaveLength(1);

    const second = makeHttp([[okResult([textRow("events")])], [okResult([], 1)]]);
    const yesDeps = makeDeps({ httpPost: second.httpPost, interactive: false, assumeYes: true });
    expect(await runTursoReset(yesDeps)).toBe(0);
    expect(second.calls[1]?.statements).toEqual(['DELETE FROM "events"']);
  });

  it("should fail before any pipeline call when the environment is not turso", async () => {
    const { httpPost, calls } = makeHttp([]);
    const deps = makeDeps({
      httpPost,
      env: { ...VALID_ENV, CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb" },
    });
    expect(await runTursoReset(deps)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("should fail when the SSM token fetch fails and never call the pipeline", async () => {
    const { httpPost, calls } = makeHttp([]);
    const deps = makeDeps({
      httpPost,
      processRunner: {
        run: vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "AccessDenied" }),
      },
    });
    expect(await runTursoReset(deps)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain("auth token を取得できませんでした");
  });

  it("should surface a pipeline step error loudly", async () => {
    const httpPost = vi.fn(async () => ({
      results: [{ type: "error", error: { message: "no such table" } }],
    }));
    const deps = makeDeps({ httpPost });
    await expect(runTursoReset(deps)).rejects.toThrow("no such table");
  });

  it("should no-op safely when the schema has no tables yet", async () => {
    const { httpPost, calls } = makeHttp([[okResult([])]]);
    const deps = makeDeps({ httpPost });
    expect(await runTursoReset(deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(deps.logs.join("\n")).toContain("削除対象の table がありません");
  });
});
