/**
 * Issue #2233 (ADR-0001 / ADR-026/027): 問題の実行先 cloud provider の共有表示定義。
 * brand 名なので locale 非依存。 未知 provider は raw 値をそのまま出す (= 新 provider
 * 追加時の安全側 fallback)。
 */
export type ProblemProvider = "aws" | "sakura" | "azure" | "gcp";

export const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  sakura: "Sakura Cloud",
  azure: "Azure",
  gcp: "Google Cloud",
};

/**
 * ライブ view の provider 解決。 旧 backend は `provider` field を送らないため、 欠損は
 * "aws" (= legacy 互換: provider 導入以前の deployment はすべて aws/cloudformation)。
 */
export function resolveProblemProvider(view: {
  readonly provider?: ProblemProvider;
}): ProblemProvider {
  return view.provider ?? "aws";
}
