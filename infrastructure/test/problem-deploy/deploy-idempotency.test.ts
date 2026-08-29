import { describe, expect, it, vi } from "vitest";
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

/**
 * Issue #3002 — handler 側の seam と、storage の異常系。
 *
 * seam (`shared.ts`) は 1 行の委譲だが、ここが runtime を通らないと backend 選択が効かず、
 * Turso 環境で DynamoDB 実装を掴む。委譲先と引数を固定する。
 */
describe("resolveIdempotencyRepository seam (Issue 3002)", () => {
  it("は runtime へ ddb と deployments table を渡す", async () => {
    const { resolveIdempotencyRepository } = await import(
      "../../lib/problem-deploy/handlers/deploy-handler/shared"
    );
    const port = { reserve: async () => ({ kind: "reserved" as const }), complete: async () => {} };
    const resolve = vi.fn().mockResolvedValue(port);
    const ddb = { send: vi.fn() };
    const result = await resolveIdempotencyRepository({
      // biome-ignore lint/suspicious/noExplicitAny: runtime は該当 1 メソッドだけ使う
      runtime: { resolveIdempotencyRepository: resolve } as any,
      ddb,
      tableName: "TestDeployments",
    });
    expect(result).toBe(port);
    expect(resolve).toHaveBeenCalledWith({ ddb, deploymentsTableName: "TestDeployments" });
  });
});

describe("DynamoDB idempotency の異常系 (Issue 3002)", () => {
  it("は ConditionalCheckFailed 以外の失敗を握り潰さない", async () => {
    // storage 障害を conflict に変換すると、「既に処理済み」と誤って replay され、
    // 本来走るべき deploy が二度と走らなくなる。
    const { DynamoDbIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const client = { send: vi.fn().mockRejectedValue(new Error("throughput exceeded")) };
    // biome-ignore lint/suspicious/noExplicitAny: send だけを持つ最小の fake
    const repo = new DynamoDbIdempotencyRepository(client as any, "T");
    await expect(
      repo.reserve({ tenantId: "t1", key: KEY, requestHash: "h", expiresAt: NOW + 60 }),
    ).rejects.toThrow("throughput exceeded");
  });

  it("は条件で負けた直後に行が消えていても conflict として扱う", async () => {
    // TTL で消えた直後の競合。「無かったこと」にして実処理を走らせると二重実行になる。
    const { DynamoDbIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const conditional = Object.assign(new Error("exists"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi.fn().mockRejectedValueOnce(conditional).mockResolvedValueOnce({});
    // biome-ignore lint/suspicious/noExplicitAny: send だけを持つ最小の fake
    const repo = new DynamoDbIdempotencyRepository({ send } as any, "T");
    const outcome = await repo.reserve({
      tenantId: "t1",
      key: KEY,
      requestHash: "h",
      expiresAt: NOW + 60,
    });
    expect(outcome.kind).toBe("conflict");
  });

  it("は記録先が消えていれば complete を no-op にする", async () => {
    const { DynamoDbIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const send = vi.fn().mockResolvedValue({});
    // biome-ignore lint/suspicious/noExplicitAny: send だけを持つ最小の fake
    const repo = new DynamoDbIdempotencyRepository({ send } as any, "T");
    await repo.complete("t1", KEY, 202, "{}");
    expect(send).toHaveBeenCalledTimes(1); // Get のみ。 Put しない
  });
});

/**
 * Issue #3002 — 保存行が壊れていた場合と、例外の種別。
 *
 * 冪等ストアは「読めたもの」で replay を決める。 壊れた行を素直に信じると、 状態を取り違えて
 * **本来走るべき deploy を止める / 二重に走らせる**のどちらかが起きる。 欠けた値をどう解釈するか
 * を固定しておく。
 */
describe("壊れた保存行と例外の扱い (Issue 3002)", () => {
  it("は DynamoDB の欠けた属性を「未完了」として読む", async () => {
    // responseStatus が無い行は「まだ結果が無い」。 数値でない値を status として返すと、
    // c.json() に渡した時点で壊れる。
    const { DynamoDbIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const conditional = Object.assign(new Error("exists"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditional)
      .mockResolvedValueOnce({ Item: { PK: "IDEM#t1", SK: `KEY#${KEY}` } });
    // biome-ignore lint/suspicious/noExplicitAny: send だけを持つ最小の fake
    const repo = new DynamoDbIdempotencyRepository({ send } as any, "T");
    const outcome = await repo.reserve({
      tenantId: "t1",
      key: KEY,
      requestHash: "h",
      expiresAt: NOW + 60,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.existing.requestHash).toBe("");
    expect(outcome.existing.responseStatus).toBeUndefined();
    expect(outcome.existing.responseBody).toBeUndefined();
    expect(outcome.existing.expiresAt).toBe(0);
  });

  it("は SQL の欠けた列を「未完了」として読む", async () => {
    const { SqlIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const uniqueViolation = Object.assign(new Error("UNIQUE constraint failed"), {});
    const executor = {
      run: vi.fn().mockRejectedValueOnce(undefined).mockRejectedValueOnce(uniqueViolation),
      get: vi.fn().mockResolvedValue({ tenant_id: "t1", key: KEY }),
      all: vi.fn(),
      batch: vi.fn(),
    };
    // 1 本目 (DELETE) は成功させる。
    executor.run = vi
      .fn()
      .mockResolvedValueOnce({ changes: 0 })
      .mockRejectedValueOnce(uniqueViolation);
    // biome-ignore lint/suspicious/noExplicitAny: 必要な 2 メソッドだけの fake
    const repo = new SqlIdempotencyRepository(executor as any, () => NOW);
    const outcome = await repo.reserve({
      tenantId: "t1",
      key: KEY,
      requestHash: "h",
      expiresAt: NOW + 60,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.existing.requestHash).toBe("");
    expect(outcome.existing.responseStatus).toBeUndefined();
    expect(outcome.existing.expiresAt).toBe(0);
  });

  it("は SQL の UNIQUE 違反以外を握り潰さない", async () => {
    const { SqlIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const executor = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ changes: 0 })
        .mockRejectedValueOnce(new Error("database is locked")),
      get: vi.fn(),
      all: vi.fn(),
      batch: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: 必要な 2 メソッドだけの fake
    const repo = new SqlIdempotencyRepository(executor as any, () => NOW);
    await expect(
      repo.reserve({ tenantId: "t1", key: KEY, requestHash: "h", expiresAt: NOW + 60 }),
    ).rejects.toThrow("database is locked");
  });

  it("は SQL の行が読めなければ、送られてきた内容を conflict の中身にする", async () => {
    // INSERT に負けた直後に行が消えるのは起こりうる。 undefined を返して呼び出し側を
    // 落とすより、 少なくとも「衝突した」ことは伝える。
    const { SqlIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const executor = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ changes: 0 })
        .mockRejectedValueOnce(
          Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }),
        ),
      get: vi.fn().mockResolvedValue(undefined),
      all: vi.fn(),
      batch: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: 必要な 2 メソッドだけの fake
    const repo = new SqlIdempotencyRepository(executor as any, () => NOW);
    const outcome = await repo.reserve({
      tenantId: "t1",
      key: KEY,
      requestHash: "sent",
      expiresAt: NOW + 60,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.existing.requestHash).toBe("sent");
  });

  it("はキー無しの記録要求を storage へ流さない", async () => {
    const complete = vi.fn();
    await finishIdempotent({
      repository: { reserve: async () => ({ kind: "reserved" }), complete },
      tenantId: "t1",
      key: undefined,
      status: 202,
      body: {},
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("は Error 以外が投げられても記録失敗を飲み込む", async () => {
    const broken: IdempotencyPort = {
      reserve: async () => ({ kind: "reserved" }),
      complete: async () => {
        // Error 以外が投げられる経路を実際に再現する。
        throw "not an error";
      },
    };
    await expect(
      finishIdempotent({
        repository: broken,
        tenantId: "t1",
        key: KEY,
        status: 202,
        body: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("は Error でない SQL 例外を UNIQUE 違反と誤認しない", async () => {
    // 文字列が投げられた場合。 UNIQUE 違反と誤認すると、 実際には書けていないのに
    // 「既にある」と判断して、 本来走るべき deploy を止めてしまう。
    const { SqlIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const executor = {
      run: vi.fn().mockResolvedValueOnce({ changes: 0 }).mockRejectedValueOnce("boom"),
      get: vi.fn(),
      all: vi.fn(),
      batch: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: 必要な 2 メソッドだけの fake
    const repo = new SqlIdempotencyRepository(executor as any, () => NOW);
    await expect(
      repo.reserve({ tenantId: "t1", key: KEY, requestHash: "h", expiresAt: NOW + 60 }),
    ).rejects.toBe("boom");
  });

  it("は保存本文が無い replay を空オブジェクトとして返す", async () => {
    const noBody: IdempotencyPort = {
      reserve: async () => ({
        kind: "conflict",
        existing: {
          tenantId: "t1",
          key: KEY,
          requestHash: hashRequest("P1", BODY),
          responseStatus: 204,
          expiresAt: NOW + 60,
        },
      }),
      complete: async () => undefined,
    };
    const replay = await begin(noBody, KEY);
    expect(replay.kind).toBe("respond");
    if (replay.kind !== "respond") return;
    expect(replay.status).toBe(204);
    expect(replay.body).toEqual({});
  });
});
