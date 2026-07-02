/**
 * Issue #2193: Lite mode のスタック名の単一 source of truth。
 *
 * 旧実装は CDK app (`bin/tenkacloud-lite.ts`) が env suffix 付きの名前で deploy する一方、
 * CLI runner (`scripts/tenkacloud-lite.ts`) が suffix なしの名前をハードコードして
 * describe/destroy しており、 development 以外の環境で status 誤報告 / teardown 不能に
 * なっていた。 本 module に名前と suffix 規則を集約し、 両者が同じ解決結果を使う。
 *
 * 依存ゼロの pure module にしてある (= CLI runner が import しても aws-cdk-lib を
 * 引き込まない)。 CDK construct は `./index.js` 側にあるので混ぜないこと。
 */

export const LITE_STACK_BASE_NAMES = {
  app: "tenkacloud-lite",
  problemDeploy: "tenkacloud-lite-problem-deploy",
} as const;

export interface LiteStackNames {
  readonly app: string;
  readonly problemDeploy: string;
}

/**
 * Issue #992: 同 AWS account に複数 env を deploy できるよう stack ID に env suffix を付ける。
 * development は suffix なし (= 旧 deploy 互換)、 staging / production 等は `-<env>`。
 * `lib/app-wiring/wire.ts` の `stackId` と同一規則 (SaaS / Lite で命名規則を揃える)。
 */
export function liteStackId(base: string, environment: string): string {
  if (environment === "development") return base;
  return `${base}-${environment}`;
}

export function resolveLiteStackNames(environment: string): LiteStackNames {
  return {
    app: liteStackId(LITE_STACK_BASE_NAMES.app, environment),
    problemDeploy: liteStackId(LITE_STACK_BASE_NAMES.problemDeploy, environment),
  };
}

/**
 * CLI runner 用の environment 解決。 CDK 側は `resolveAppConfig` (app-config/resolve.ts)
 * が同じ規則 (`CDK_PARAM_ENVIRONMENT ?? "development"`) で解決するため、 これと一致させる。
 */
export function resolveLiteEnvironment(env: NodeJS.ProcessEnv): string {
  return env.CDK_PARAM_ENVIRONMENT ?? "development";
}
