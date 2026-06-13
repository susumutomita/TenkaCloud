import {
  type DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
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
  ddb: DynamoDBDocumentClient,
  input: QueryCommandInput,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new QueryCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    if (out.Items) items.push(...out.Items);
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
