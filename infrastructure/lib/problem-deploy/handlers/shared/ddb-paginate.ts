import {
  type DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

/**
 * Query を全ページ drain して全 Items を返す。
 *
 * DynamoDB の Query は 1 ページ最大 1MB で `LastEvaluatedKey` を返すため、単発 `send` +
 * `out.Items` だと後続ページを黙って取りこぼす (#1797 / #1815)。特に
 * `GSI1PK = TENANT#<id>` + `FilterExpression` 形は filter が各ページ内で適用されるので、
 * 目的の行が後続ページに居ると完全に missed になる (= leaderboard が team を欠落させる、
 * teardown が stack を enqueue し損ねる、disruption executor が deployment を見つけられず
 * silent no-op、等)。本 helper で全件取得を保証し、各 call site で pagination loop を
 * 書き写す (= bug を copy する) のを防ぐ。
 *
 * 呼び出し側は `ExclusiveStartKey` を渡してはいけない (本 helper が管理する)。
 */
export async function queryAllItems(
  ddb: Pick<DynamoDBDocumentClient, "send">,
  input: QueryCommandInput,
): Promise<Record<string, unknown>[]> {
  return queryAllItemsBounded(ddb, input, Number.POSITIVE_INFINITY);
}

/**
 * {@link queryAllItems} の上限付き版。最大 `maxPages` ページまで辿る。
 *
 * 全件 drain せず「1 partition あたり最大 N ページ」で打ち止めたい呼び出し側 (= 1 request
 * あたりの query 回数を bound したい score-event timeline 等) のために提供する。`maxPages` に
 * 達したら `LastEvaluatedKey` が残っていても停止する。`maxPages` は 1 以上であること。
 *
 * 呼び出し側は `ExclusiveStartKey` を渡してはいけない (本 helper が管理する)。
 */
export async function queryAllItemsBounded(
  ddb: Pick<DynamoDBDocumentClient, "send">,
  input: QueryCommandInput,
  maxPages: number,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const out = await ddb.send(
      new QueryCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    if (out.Items) items.push(...out.Items);
    exclusiveStartKey = out.LastEvaluatedKey;
    pages++;
    if (!exclusiveStartKey) break;
  }
  return items;
}

/**
 * Scan を全ページ drain し、各ページの `Items` を `onPage` callback に順番に渡す。
 *
 * Query 同様 Scan も 1 ページ最大 1MB で `LastEvaluatedKey` を返すため、`ExclusiveStartKey`
 * ループを書かないと後続ページを黙って取りこぼす (#1797 / #1815)。`scanAllItems` (= 全件を
 * メモリに集めて返す) と違い、本 iterator は **ページ単位の副作用** (= 1 page の BatchGet /
 * 並列 Promise.all 処理) を保ったまま pagination だけを集約したい呼び出し向け。全件を 1 度に
 * 集めると BatchGet の 100 件上限や Promise.all の並列幅が変わってしまうため、scoring tick の
 * ような per-page 処理ではこちらを使う。
 *
 * 呼び出し側は `ExclusiveStartKey` を渡してはいけない (本 helper が管理する)。`onPage` には
 * 各ページの `Items` (欠落時は空配列) が渡る。
 */
export async function forEachScanPage(
  ddb: Pick<DynamoDBDocumentClient, "send">,
  input: ScanCommandInput,
  onPage: (items: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    await onPage(out.Items ?? []);
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

/**
 * Scan を全ページ drain して全 Items を返す (= `queryAllItems` の Scan 版)。
 *
 * ページ単位の副作用が不要で、純粋に「全件を 1 配列で欲しい」呼び出し向け。per-page 処理が
 * 要る場合は {@link forEachScanPage} を使う。呼び出し側は `ExclusiveStartKey` を渡してはいけない。
 */
export async function scanAllItems(
  ddb: Pick<DynamoDBDocumentClient, "send">,
  input: ScanCommandInput,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  await forEachScanPage(ddb, input, async (page) => {
    items.push(...page);
  });
  return items;
}
