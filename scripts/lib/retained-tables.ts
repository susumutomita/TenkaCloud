/**
 * Issue #2444: destroy 後に残存する RETAIN テーブルを列挙して billing 警告を出すための
 * pure logic module。
 *
 * 背景: 現在の Lite DynamoDB は default `RemovalPolicy.DESTROY` だが、明示的な
 * `CDK_PARAM_RETAIN_DATA_TABLES=true` や旧 stack では `RemovalPolicy.RETAIN` になりうる。
 * その table は `make destroy` 後も残り、`DynamoDbLowCapacity` aspect が設定した
 * PROVISIONED 1 RCU / 1 WCU の standing cost を出し続ける。deploy/destroy を繰り返すと
 * orphan が蓄積して「消したのに課金され続ける」状態に気づけない (トラッカー #2435)。
 *
 * 本 module は残存テーブルを **列挙して警告するだけ** で、削除は一切しない（明示的に
 * 保持した履歴や他環境の誤削除を防ぐ）。依存ゼロの pure module にしてあり、AWS SDK も CDK も
 * 引き込まない。 aws CLI は `AwsRunner` seam 経由で注入するので unit test は AWS を
 * 触らずに全経路を観測できる。
 */

export interface RetainedTable {
  readonly name: string;
  /** table に付く GSI 本数。 各 GSI も aspect により 1 RCU / 1 WCU で provisioned。 */
  readonly gsiCount: number;
}

/**
 * ap-northeast-1 (Tokyo) で 1 RCU + 1 WCU の pair を 1 ヶ月 provisioned し続けた概算月額。
 * 導出: 1 RCU-hour = $0.0001484、 1 WCU-hour = $0.000742。 約 730 h/月 で
 * $0.108 + $0.542 ≈ $0.64。 TenkaCloud の全 table / GSI は `DynamoDbLowCapacity` aspect で
 * 例外なくこの 1/1 pair に固定されるので、 コストは (table 数 + GSI 数) に線形に比例する。
 */
export const MONTHLY_COST_PER_UNIT_PAIR_USD = 0.64;

/** TenkaCloud の全 stack (= 自動命名される DynamoDB table) が持つ共通 prefix。 */
export const TENKACLOUD_TABLE_NAME_PREFIX = "tenkacloud";

/** aws CLI 実行 seam の結果。 tenkacloud-lite の spawnCapture と同型。 */
export interface AwsResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `aws <args>` を実行する seam。 unit test では fake runner を注入する。 */
export type AwsRunner = (args: readonly string[]) => Promise<AwsResult>;

/** 警告文の出力先 (process.stdout.write / Lite CLI の io.stdout)。 */
export type Write = (text: string) => void;

/**
 * table 名が TenkaCloud 由来か判定する。 CloudFormation は stack 名 (= `tenkacloud-*`) を
 * そのまま自動命名の prefix に焼くので、 prefix 一致で同定できる。 cleanup.sh が Cognito
 * UserPool / API Key の orphan sweep で使う `tenkacloud-*` 判定と揃える (= 他プロジェクトの
 * table を巻き込まない安全策)。 case は念のため無視する。
 */
export function isTenkaCloudTable(name: string): boolean {
  return name.toLowerCase().startsWith(TENKACLOUD_TABLE_NAME_PREFIX);
}

/** table 1 個が占める unit pair 数 = base table 1 + GSI 本数 (各々 1 RCU / 1 WCU)。 */
export function unitPairsFor(table: RetainedTable): number {
  return 1 + table.gsiCount;
}

/** 残存 table 群が占める unit pair の総数。 */
export function totalUnitPairs(tables: readonly RetainedTable[]): number {
  return tables.reduce((sum, table) => sum + unitPairsFor(table), 0);
}

/** 残存 table 群の概算月額 (USD)。 */
export function estimateMonthlyCostUsd(tables: readonly RetainedTable[]): number {
  return totalUnitPairs(tables) * MONTHLY_COST_PER_UNIT_PAIR_USD;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * `aws dynamodb list-tables --output json` の stdout から TableNames を取り出す。
 * 期待する形 (= 文字列の配列) でなければ undefined を返す。
 */
export function parseTableNames(stdout: string): readonly string[] | undefined {
  try {
    const parsed = JSON.parse(stdout);
    const names = parsed?.TableNames;
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
      return names;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `aws dynamodb describe-table ... --query Table.GlobalSecondaryIndexes --output json` の
 * stdout から GSI 本数を数える。 GSI が無い table は query が `null` を返すので 0 とする。
 */
export function parseGsiCount(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 残存する TenkaCloud table を列挙し、 各 table の GSI 本数まで解決する。
 * list 失敗 (aws exit code != 0) は `listFailed: true` で返す — 呼び出し側は warning に
 * 留めて exit code を変えないこと (Issue #2444 の明示仕様)。
 */
export async function collectRetainedTables(
  runAws: AwsRunner,
): Promise<{ readonly tables: readonly RetainedTable[]; readonly listFailed: boolean }> {
  const listed = await runAws(["dynamodb", "list-tables", "--output", "json"]);
  if (listed.code !== 0) {
    return { tables: [], listFailed: true };
  }
  const names = parseTableNames(listed.stdout);
  if (names === undefined) {
    return { tables: [], listFailed: false };
  }
  const tables: RetainedTable[] = [];
  for (const name of names.filter(isTenkaCloudTable)) {
    const described = await runAws([
      "dynamodb",
      "describe-table",
      "--table-name",
      name,
      "--query",
      "Table.GlobalSecondaryIndexes",
      "--output",
      "json",
    ]);
    // describe 失敗は GSI 数不明として 0 扱い (= コスト過少評価だが、 残存事実の警告は出す)。
    const gsiCount = described.code === 0 ? parseGsiCount(described.stdout) : 0;
    tables.push({ name, gsiCount });
  }
  return { tables, listFailed: false };
}

/** 残存する各 table と削除コマンド例、 概算月額をまとめた警告文を組み立てる。 */
export function buildRetainedTablesWarning(tables: readonly RetainedTable[]): string {
  const totalGsi = tables.reduce((sum, table) => sum + table.gsiCount, 0);
  const totalCost = usd(estimateMonthlyCostUsd(tables));
  const lines: string[] = [
    "",
    "================================================================",
    `注意: RETAIN された DynamoDB テーブルが ${tables.length} 件残っています (Issue #2444)`,
    "================================================================",
    "RemovalPolicy.RETAIN のため destroy 後も残存し、 PROVISIONED 1 RCU / 1 WCU の",
    `standing cost (≈ ${totalCost}/月, ap-northeast-1) を出し続けます。`,
    "履歴保全のための意図的な残存です。 不要になったら手動で削除してください:",
    "",
  ];
  for (const table of tables) {
    const gsiNote = table.gsiCount > 0 ? ` (GSI ${table.gsiCount} 本)` : "";
    const cost = usd(unitPairsFor(table) * MONTHLY_COST_PER_UNIT_PAIR_USD);
    lines.push(`  ${table.name}${gsiNote}  ≈ ${cost}/月`);
    lines.push(`    aws dynamodb delete-table --table-name ${table.name}`);
  }
  lines.push("");
  lines.push(
    `合計: ${tables.length} テーブル + ${totalGsi} GSI = ${totalUnitPairs(tables)} ユニット組 ≈ ${totalCost}/月`,
  );
  lines.push("================================================================");
  lines.push("");
  return lines.join("\n");
}

function retainedCheckSkippedNote(): string {
  return (
    "\n[destroy] 注意: DynamoDB テーブルの残存確認をスキップしました " +
    "(aws dynamodb list-tables が実行できませんでした)。\n" +
    "[destroy] RETAIN されたテーブルが課金され続けている可能性があります。 " +
    "`aws dynamodb list-tables` を手動で確認してください。\n"
  );
}

/**
 * destroy 完了時に残存 RETAIN テーブルの警告を出力する。 副作用は `write` への出力のみで、
 * 削除は一切しない。 何が起きても例外を投げず戻り値も無い (= 呼び出し側の exit code を
 * 絶対に変えない)。 残存ゼロなら何も出力しない。
 */
export async function reportRetainedTables(runAws: AwsRunner, write: Write): Promise<void> {
  let result: Awaited<ReturnType<typeof collectRetainedTables>>;
  try {
    result = await collectRetainedTables(runAws);
  } catch {
    // list/describe が想定外に throw しても destroy の exit code は変えない (Issue #2444)。
    write(retainedCheckSkippedNote());
    return;
  }
  if (result.listFailed) {
    write(retainedCheckSkippedNote());
    return;
  }
  if (result.tables.length === 0) {
    return;
  }
  write(buildRetainedTablesWarning(result.tables));
}
