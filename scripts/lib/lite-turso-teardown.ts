/**
 * Lite teardown の Turso 側 (Issue 2992)。
 *
 * ## なぜ必要か
 *
 * `make destroy` / `make destroy-all` は CloudFormation stack を消す。 DynamoDB backend では
 * それで control-data も消える (table が stack の持ち物なので) が、 **Turso backend では
 * database が AWS の外にある**ため、 stack を全部消しても event / team / deployment の行は
 * そのまま残る。 実測でも destroy 完了後に team と score の行が残っていた。
 *
 * `make turso-reset` という初期化専用コマンドは既にある (2026-07-21 のライブ検証で「初期化
 * 手段が無い」ことが判明して追加された)。 ただし destroy から呼ばれていないので、 運営が
 * 自分で思い出して叩かない限りデータは永久に残る。 DynamoDB backend なら残存 table の警告が
 * 出るのに、 Turso backend では**その警告すら出ない**ので、 気づく手がかりが無い。
 *
 * ## ここが決めること
 *
 * 判断だけを純粋関数として切り出す。 実際の削除は既存の `runTursoReset` をそのまま使い、
 * ロジックを二重に持たない。
 *
 * `--purge-retained-data` (= `make destroy-all`) のときだけ実際に消す。 通常の
 * `make destroy` は AWS 資源だけを消す約束なので、 外部 database を黙って空にするのは
 * やりすぎ — 代わりに何が残っているかを明示する。
 */

/** backend 判定。 `resolveTursoResetTarget` と同じ正規化 (trim + 小文字化) を使う。 */
export function isTursoBackend(env: NodeJS.ProcessEnv): boolean {
  return env.CDK_PARAM_CONTROL_DATA_BACKEND?.trim().toLowerCase() === "turso";
}

export type TursoTeardownPlan =
  /** `destroy-all`: control-data を実際に消す。 */
  | { readonly kind: "purge" }
  /** `destroy`: 消さないが、残ることを告げる。 */
  | { readonly kind: "warn"; readonly message: string }
  /** Turso backend ではない (= stack を消せば control-data も消える)。 */
  | { readonly kind: "not-turso" };

export function planTursoTeardown(
  env: NodeJS.ProcessEnv,
  purgeRetainedData: boolean,
): TursoTeardownPlan {
  if (!isTursoBackend(env)) return { kind: "not-turso" };
  if (purgeRetainedData) return { kind: "purge" };
  return {
    kind: "warn",
    message:
      "[lite] control-data backend は turso です。 Turso database 上の event / team / deployment 行は" +
      " stack を消しても残ります (AWS の外にあるため)。\n" +
      "[lite] 消す場合は `make turso-reset` を実行してください。 `make destroy-all` なら teardown の" +
      " 一部として自動で実行されます。\n",
  };
}
