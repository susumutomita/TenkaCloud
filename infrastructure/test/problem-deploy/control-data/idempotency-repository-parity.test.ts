import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DynamoDbIdempotencyRepository,
  IDEMPOTENCY_TABLE_SQL,
  type IdempotencyPort,
  type IdempotencyRecord,
  SqlIdempotencyRepository,
} from "../../../lib/problem-deploy/control-data/idempotency-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/sql-port";
import { makeFakeDdb } from "./control-data-write.test-helpers";

/**
 * Issue #3002 — `Idempotency-Key` の保存先を両 backend で同じに保つ parity suite。
 *
 * ## なぜ parity で書くか
 *
 * `/deploy` は DynamoDB backend でも SQL (Turso) backend でも動く。 DynamoDB にだけ冪等ストアを
 * 実装すると、 **Turso の環境は黙って無防備なまま**になる。 二重デプロイが防げているように見えて
 * 防げていない、 という一番良くない壊れ方で、 片方だけのテストでは決して見つからない。
 *
 * なので同じ assertion を両方へ流す。 片方の実装を消す / 壊すと、 このファイルのその backend の
 * 行だけが落ちる。
 *
 * ## 排他の検証について
 *
 * 「2 回目の reserve が conflict になる」だけでなく、 **1 回目だけが reserved になる**ことを
 * 見ている。 read してから write する実装は前者を満たしても後者を満たさない (並行して両方が
 * read を抜けられる) ので、 その差が出る形にしてある。
 */

const NOW = 1_800_000_000; // 固定 unix 秒。 期限切れの判定を時計から切り離す。
const TTL = 24 * 60 * 60;

function record(over: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    tenantId: "t1",
    key: "11111111-2222-4333-8444-555555555555",
    requestHash: "hash-A",
    expiresAt: NOW + TTL,
    ...over,
  };
}

function makeSqlExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  db.exec(IDEMPOTENCY_TABLE_SQL);
  return {
    run: (sql, params = []) => ({ changes: db.prepare(sql).run(...params).changes }),
    get: (sql, params = []) =>
      db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    all: (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    batch: (statements) =>
      statements.map((s) => ({ changes: db.prepare(s.sql).run(...(s.params ?? [])).changes })),
  } as SqlExecutor;
}

const BACKENDS: ReadonlyArray<readonly [string, () => IdempotencyPort]> = [
  ["DynamoDB", () => new DynamoDbIdempotencyRepository(makeFakeDdb(), "deployments-table")],
  ["SQL (Turso)", () => new SqlIdempotencyRepository(makeSqlExecutor(), () => NOW)],
];

describe.each(BACKENDS)("Idempotency parity — %s (Issue 3002)", (_name, make) => {
  it("は最初の予約だけを通す", async () => {
    const repo = make();
    expect(await repo.reserve(record())).toEqual({ kind: "reserved" });
  });

  it("は同じキーの 2 回目を conflict にする", async () => {
    // これが無いと、 再送のたびに deploy が走って stack が増える。
    const repo = make();
    await repo.reserve(record());
    const second = await repo.reserve(record());
    expect(second.kind).toBe("conflict");
  });

  it("は並行しても 1 本しか reserved にしない", async () => {
    // read-then-write の実装はここで落ちる。 5 本同時に投げて reserved は 1 本だけのはず。
    const repo = make();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => repo.reserve(record())));
    expect(outcomes.filter((o) => o.kind === "reserved")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "conflict")).toHaveLength(4);
  });

  it("は完了したレスポンスを次の再送へ引き継ぐ", async () => {
    const repo = make();
    await repo.reserve(record());
    await repo.complete("t1", record().key, 202, '{"jobId":"J1"}');
    const replay = await repo.reserve(record());
    expect(replay.kind).toBe("conflict");
    if (replay.kind !== "conflict") return;
    expect(replay.existing.responseStatus).toBe(202);
    expect(replay.existing.responseBody).toBe('{"jobId":"J1"}');
  });

  it("は処理中 (未完了) を完了と区別する", async () => {
    // 1 回目がまだ走っている最中の再送。 replay するレスポンスがまだ無い状態を
    // 「レスポンス無しの conflict」として見分けられること。
    const repo = make();
    await repo.reserve(record());
    const inFlight = await repo.reserve(record());
    expect(inFlight.kind).toBe("conflict");
    if (inFlight.kind !== "conflict") return;
    expect(inFlight.existing.responseStatus).toBeUndefined();
  });

  it("は同じキーに違うリクエストが来たことを検出できる", async () => {
    // 呼び出し側が requestHash を突き合わせてエラーにするための材料を返すこと。
    const repo = make();
    await repo.reserve(record({ requestHash: "hash-A" }));
    const other = await repo.reserve(record({ requestHash: "hash-B" }));
    expect(other.kind).toBe("conflict");
    if (other.kind !== "conflict") return;
    expect(other.existing.requestHash).toBe("hash-A");
  });

  it("はテナントが違えば同じキーでも独立させる", async () => {
    // tenant 跨ぎで衝突すると、 他テナントの deploy を止められてしまう。
    const repo = make();
    await repo.reserve(record({ tenantId: "t1" }));
    expect(await repo.reserve(record({ tenantId: "t2" }))).toEqual({ kind: "reserved" });
  });
});

describe("Idempotency 期限切れ — SQL (Issue 3002)", () => {
  it("は期限切れのキーを再利用できる", async () => {
    // SQLite に TTL は無いので、 消し込みが効いていないと同じキーが二度と使えなくなる。
    // DynamoDB 側は table の TTL 属性が同じ役割を担うため、 ここは SQL 固有の検証。
    const executor = makeSqlExecutor();
    const expired = new SqlIdempotencyRepository(executor, () => NOW);
    await expired.reserve(record({ expiresAt: NOW + 10 }));

    const later = new SqlIdempotencyRepository(executor, () => NOW + 3600);
    expect(await later.reserve(record({ expiresAt: NOW + 3600 + TTL }))).toEqual({
      kind: "reserved",
    });
  });

  it("は期限内のキーを再利用させない", async () => {
    const executor = makeSqlExecutor();
    const repo = new SqlIdempotencyRepository(executor, () => NOW);
    await repo.reserve(record());
    const soon = new SqlIdempotencyRepository(executor, () => NOW + 60);
    expect((await soon.reserve(record())).kind).toBe("conflict");
  });
});
