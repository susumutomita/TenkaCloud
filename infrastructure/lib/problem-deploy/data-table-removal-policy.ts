import { RemovalPolicy } from "aws-cdk-lib";

/**
 * Issue #2959: control-data DynamoDB table の削除方針。
 *
 * ## 既定が DESTROY である理由
 *
 * 以前は 8 table すべてが `RemovalPolicy.RETAIN` を明示していた。「stack delete で event 履歴を
 * 意図せず消さない」という #2444 / #2445 の方針で、`scripts/cleanup.sh` も残存 table を
 * **列挙して警告するだけ**だった。
 *
 * しかしこの運用の実測結果は、消し忘れた 8 table + GSI 7 本 = 15 ユニット組が PROVISIONED
 * 1 RCU / 1 WCU で約 3 か月課金され続ける (約 $9.60/月) というものだった。守るべきものが
 * 「意図せず消えないこと」ではなく **「意図せず課金が残らないこと」** だと判断が変わったので、
 * 既定を DESTROY に反転し、RETAIN を opt-in にする。
 *
 * ## 環境名で分岐しない
 *
 * `CDK_PARAM_RETAIN_DATA_TABLES=true` だけが RETAIN を選ぶ経路で、environment による暗黙の
 * 分岐は入れない。入れると「本番だけ消えない」という別の消し忘れを作るだけになる。
 *
 * ## いつ効くか
 *
 * `DeletionPolicy` / `UpdateReplacePolicy` は **CFn に載っている値**が使われる。既に RETAIN で
 * deploy 済みの stack を消す場合、先に `deploy` してテンプレートを更新しておかないと古い RETAIN
 * のままなので効かない。deploy 時点でデータは消えない (UPDATE であって REPLACE ではない)。
 */
export function dataTableRemovalPolicy(retain: boolean | undefined): RemovalPolicy {
  return retain === true ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/** 8 つの control-data table construct が共通で受け取る props。 */
export interface DataTableProps {
  /**
   * table の `RemovalPolicy`。未指定なら DESTROY (= 既定)。呼び出し側は
   * `dataTableRemovalPolicy(config.retainDataTables)` を渡す。
   */
  readonly removalPolicy?: RemovalPolicy;
}
