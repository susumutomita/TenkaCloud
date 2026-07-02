/**
 * [#2233] 問題が動く cloud provider の共有ヘルパ。
 *
 * ADR-026 / ADR-027: 実行先 cloud を競技者に明示する表示名。brand 名なので locale 非依存。
 * 未知 provider は raw 値をそのまま出す (= 新 provider 追加時の安全側 fallback)。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  sakura: "Sakura Cloud",
  azure: "Azure",
  gcp: "Google Cloud",
};

/** 表示名を引く。未知 provider は raw 値 fallback (prototype 連鎖は引かない)。 */
export function providerLabel(provider: string): string {
  return Object.hasOwn(PROVIDER_LABEL, provider) ? PROVIDER_LABEL[provider] : provider;
}

/**
 * ParticipantProblemView の provider を解決する。行契約 (backend resolveViewProvider と同じ):
 * provider 欠落 / 空 = aws (旧 backend 応答 / legacy 行との互換)。
 */
export function problemProvider(problem: { readonly provider?: string }): string {
  return typeof problem.provider === "string" && problem.provider !== "" ? problem.provider : "aws";
}
