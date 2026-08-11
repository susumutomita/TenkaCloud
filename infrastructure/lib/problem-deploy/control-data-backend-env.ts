/**
 * Issue #2290: control-plane data backend の選択フラグを Lambda env へ落とす
 * CDK helper (`audit-log-env.ts` の mirror)。
 *
 * Events / Teams repository を組み立てる handler (event-handler の `getEventDetail`) は
 * cold-start factory `createEventsRepository` / `createTeamsRepository` を通り、その selector は
 * env `CONTROL_DATA_BACKEND` を読む。未設定なら factory は `dynamodb` に fallback する
 * (= **default = DDB**)。
 *
 * したがって:
 *   - `dynamodb` (default) → env を **足さない** (= 既存テンプレートと byte 互換、 CFn 差分 0、
 *     factory は unset で dynamodb に落ちるので挙動も不変)。
 *   - `turso` → `CONTROL_DATA_BACKEND="<backend>"` を注入し、 factory が SQLite 実装を選ぶ。
 *
 * 各 Lambda construct が同じ条件式を lockstep で持つと drift の温床になるため
 * (`app-wiring/problem-deploy-backend-props.ts` の教訓)、 1 helper に集約する。
 */
export function controlDataBackendEnv(backend: string): Record<string, string> {
  return backend === "dynamodb" ? {} : { CONTROL_DATA_BACKEND: backend };
}

/** {@link controlDataRuntimeEnv} が受ける control-data 3 点セット。 */
export interface ControlDataRuntimeEnvProps {
  /** `dynamodb` | `turso`。 未指定は `dynamodb` (= env を足さず byte 互換)。 */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL (turso backend のみ)。 */
  readonly tursoDatabaseUrl?: string;
  /** libSQL auth token を持つ SSM SecureString parameter 名 (turso backend のみ)。 */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * 「DB を開く Lambda」が必要とする control-data env を 1 か所で組み立てる
 * ({@link controlDataBackendEnv} + Turso executor 配線の 2 変数)。
 *
 * `controlDataBackendEnv` の doc が書いているとおり、各 Lambda construct が同じ条件式を
 * lockstep で持つのは drift の温床。 backend フラグ 1 行だけを helper 化しても、実際には
 * その直後に来る `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN_PARAMETER_NAME` の 2 つの
 * 三項演算子が必ず同伴するため、3 点まとめて集約する。
 *
 * key の並び (`CONTROL_DATA_BACKEND` → `TURSO_DATABASE_URL` →
 * `TURSO_AUTH_TOKEN_PARAMETER_NAME`) は既存 construct の inline 版と同一。 呼び出し元が
 * 同じ位置に spread すれば `Environment.Variables` は byte 互換のまま置き換えられる。
 *
 * 既存 construct 群 (admin-insight-api-lambda / saml-idp-lambda / sign-in-audit-lambda 等) は
 * まだ inline のまま。 それぞれ synth 出力が既存テストに pin されているので、移行は
 * 各 construct を触る PR で 1 つずつ行う (本 helper への一括移行は byte 互換の再証明が要る)。
 */
export function controlDataRuntimeEnv(props: ControlDataRuntimeEnvProps): Record<string, string> {
  return {
    ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
    ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
    ...(props.tursoAuthTokenParameterName
      ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
      : {}),
  };
}
