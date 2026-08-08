/**
 * `aws:cdk:bundling-stacks` context の解決 (env → context 値)。
 *
 * CLI の `-c` は `aws:` prefix を拒否するため、 この context は code 側で設定するしかない。
 * bin/infrastructure.ts から呼ばれる。 判定を bin に inline せず純関数に切り出しているのは、
 * 「どの env でどの stack が bundle されるか」が deploy の安全性に直結する (= 誤ると stub asset
 * を本番 stack へ配ってしまう) のに、 bin 自体は import した瞬間に app 全体を synth するため
 * 単体で test できないから。
 *
 * 優先順位:
 *   1. `CDK_SKIP_BUNDLING=1` → `[]` (= 全 stack skip)。 `make check-synth` 用 (#1446)。
 *      shape 検証だけが目的で Docker 不要。 deploy には使えない。
 *   2. `CDK_BUNDLING_STACKS="a,b"` → `["a","b"]` (= 列挙した stack だけ bundle)。
 *      tenant provisioning が CodeBuild から 1 stack だけ deploy するとき用。 synth は app 全体を
 *      構築するので、 絞らないと deploy 対象ですらない ControlPlaneStack の Python Lambda まで
 *      Docker build しに行き、 CodeBuild 上でその build が落ちて deploy が丸ごと失敗する
 *      (2026-08-08 testsilo: `pip install pipenv poetry` が exit 255)。
 *      **必ず `cdk deploy --exclusively` と対で使うこと。** 単独で使うと、 bundle を skip した
 *      依存 stack が stub asset のまま deploy 対象に含まれてしまう。
 *   3. どちらも無い → `undefined` (= context を設定しない = CDK 既定の全 stack bundle)。
 */
export function resolveBundlingStacks(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.CDK_SKIP_BUNDLING === "1") {
    return [];
  }

  const scoped = env.CDK_BUNDLING_STACKS;
  if (!scoped) {
    return undefined;
  }

  const stackNames = scoped
    .split(",")
    .map((stackName) => stackName.trim())
    .filter((stackName) => stackName.length > 0);

  // 空白だけ / カンマだけを渡されたときに `[]` を返すと「全 stack skip」に化けて、 deploy 対象の
  // Lambda まで stub になる。 指定が実質空なら未指定として扱い、 既定の全 bundle に倒す。
  return stackNames.length > 0 ? stackNames : undefined;
}
