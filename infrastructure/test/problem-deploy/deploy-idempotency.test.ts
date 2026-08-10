import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_TABLE_SQL,
  type IdempotencyPort,
  SqlIdempotencyRepository,
} from "../../lib/problem-deploy/control-data/idempotency-repository";
import type { SqlExecutor } from "../../lib/problem-deploy/control-data/sql-port";
import {
  beginIdempotent,
  finishIdempotent,
  hashRequest,
  validateKey,
} from "../../lib/problem-deploy/handlers/deploy-handler/idempotency";

/**
 * Issue #3002 — `POST /problems/{problemId}/deploy` の `Idempotency-Key` の判断部分。
 *
 * storage の parity は `control-data/idempotency-repository-parity.test.ts` が両 backend で
 * 見ている。 こちらは route が使う「replay するか / 進めるか / 断るか」の分岐を固定する。
 *
 * 一番大事なのは **1 回目が成功した後の再送で実処理が走らない**ことで、 これが崩れると
 * 競技アカウントに CloudFormation stack が 2 つできる。
 */

const NOW = 1_800_000_000;
const KEY = "11111111-2222-4333-8444-555555555555";
const BODY = { awsAccountId: "111122223333", region: "ap-northeast-1" };

function makeRepo(): IdempotencyPort {
  // node:sqlite の in-memory。 実際の UNIQUE 制約で排他を確かめる (fake を作らない)。
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(IDEMPOTENCY_TABLE_SQL);
  const executor = {
    run: (sql: string, params: readonly unknown[] = []) => ({
      changes: db.prepare(sql).run(...(params as never[])).changes,
    }),
    get: (sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined,
    all: (sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    batch: (statements: readonly { sql: string; params?: readonly unknown[] }[]) =>
      statements.map((s) => ({
        changes: db.prepare(s.sql).run(...((s.params ?? []) as never[])).changes,
      })),
  } as unknown as SqlExecutor;
  return new SqlIdempotencyRepository(executor, () => NOW);
}

function begin(repository: IdempotencyPort, key: string | undefined, body: unknown = BODY) {
  return beginIdempotent({
    repository,
    tenantId: "t1",
    key,
    requestHash: hashRequest("P1", body),
    nowSeconds: NOW,
  });
}

describe("deploy Idempotency-Key (Issue 3002)", () => {
  it("はヘッダが無ければ従来どおり素通りさせる", async () => {
    // 既存クライアントを壊さないこと。 ここが崩れると全 deploy が止まる。
    expect(await begin(makeRepo(), undefined)).toEqual({ kind: "proceed" });
  });

  it("は初回を通す", async () => {
    expect(await begin(makeRepo(), KEY)).toEqual({ kind: "proceed", key: KEY });
  });

  it("は成功した deploy の再送に 1 回目の結果を返し、実処理を走らせない", async () => {
    // この問題の本体。 proceed が返ると deploy が 2 回走り、stack が 2 つできる。
    const repo = makeRepo();
    await begin(repo, KEY);
    await finishIdempotent({
      repository: repo,
      tenantId: "t1",
      key: KEY,
      status: 202,
      body: { jobId: "J1" },
    });

    const replay = await begin(repo, KEY);
    expect(replay.kind).toBe("respond");
    if (replay.kind !== "respond") return;
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ jobId: "J1" });
  });

  it("は失敗した deploy の再送にも 1 回目の結果を返す", async () => {
    // 失敗を記録しないと、再送のたびに実処理が走る。Stripe も成功・失敗を問わず replay する。
    const repo = makeRepo();
    await begin(repo, KEY);
    await finishIdempotent({
      repository: repo,
      tenantId: "t1",
      key: KEY,
      status: 422,
      body: { error: "account_not_verified" },
    });

    const replay = await begin(repo, KEY);
    expect(replay.kind).toBe("respond");
    if (replay.kind !== "respond") return;
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ error: "account_not_verified" });
  });

  it("は処理中の再送を 409 で断る", async () => {
    const repo = makeRepo();
    await begin(repo, KEY);
    const second = await begin(repo, KEY);
    expect(second).toEqual({
      kind: "respond",
      status: 409,
      body: { error: "idempotency_request_in_progress" },
    });
  });

  it("は同じキーに違う本文が来たら 422 で断る", async () => {
    // replay すると 1 回目の結果が 2 回目の答えとして返ってしまう。
    const repo = makeRepo();
    await begin(repo, KEY, BODY);
    const other = await begin(repo, KEY, { awsAccountId: "999988887777" });
    expect(other).toEqual({
      kind: "respond",
      status: 422,
      body: { error: "idempotency_key_reused" },
    });
  });

  it("は空のキーと長すぎるキーを 400 で断る", async () => {
    const repo = makeRepo();
    expect((await begin(repo, "")).kind).toBe("respond");
    expect((await begin(repo, "x".repeat(256))).kind).toBe("respond");
    // 境界の 255 は通ること。
    expect((await begin(repo, "x".repeat(255))).kind).toBe("proceed");
  });

  it("は記録に失敗しても本来のレスポンスを潰さない", async () => {
    // deploy は成功しているのに記録の失敗でエラーを返すと、相手はもう一度送る。
    // それは記録漏れよりはるかに悪い。
    const broken: IdempotencyPort = {
      reserve: async () => ({ kind: "reserved" }),
      complete: async () => {
        throw new Error("storage down");
      },
    };
    await expect(
      finishIdempotent({
        repository: broken,
        tenantId: "t1",
        key: KEY,
        status: 202,
        body: { jobId: "J1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("は壊れた保存本文をでっち上げた成功にしない", async () => {
    // 保存済みの本文が JSON として読めない状態 (途中で切れた書き込み、後方非互換な形式変更)。
    // ここで `{}` を返すと、 呼び出し側は「成功して jobId が無い」レスポンスを受け取り、
    // 何が起きたのか分からなくなる。 読めないことを言う。
    const corrupt: IdempotencyPort = {
      reserve: async () => ({
        kind: "conflict",
        existing: {
          tenantId: "t1",
          key: KEY,
          requestHash: hashRequest("P1", BODY),
          responseStatus: 202,
          responseBody: "{not json",
          expiresAt: NOW + 3600,
        },
      }),
      complete: async () => undefined,
    };
    const replay = await begin(corrupt, KEY);
    expect(replay.kind).toBe("respond");
    if (replay.kind !== "respond") return;
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ error: "idempotency_replay_unavailable" });
  });

  it("はキーの形だけを見る検証を storage の前に効かせる", () => {
    expect(validateKey("")).toBe("idempotency_key_empty");
    expect(validateKey("x".repeat(256))).toBe("idempotency_key_too_long");
    expect(validateKey(KEY)).toBeUndefined();
  });
});
