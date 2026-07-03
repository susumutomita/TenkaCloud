/**
 * Issue #2290 (ADR-049 §5.1): control-plane data backend の選択フラグを Lambda env へ落とす
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
 *   - `turso` / `sql` → `CONTROL_DATA_BACKEND="<backend>"` を注入し、 factory が SQLite 実装を選ぶ。
 *
 * 各 Lambda construct が同じ条件式を lockstep で持つと drift の温床になるため
 * (`app-wiring/problem-deploy-backend-props.ts` の教訓)、 1 helper に集約する。
 */
export function controlDataBackendEnv(backend: string): Record<string, string> {
  return backend === "dynamodb" ? {} : { CONTROL_DATA_BACKEND: backend };
}
