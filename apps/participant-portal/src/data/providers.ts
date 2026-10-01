/**
 * [#2233] 問題が動く cloud provider の共有ヘルパ。
 *
 * 実行先 cloud を競技者に明示する表示名。brand 名なので locale 非依存。
 * 未知 provider は raw 値をそのまま出す (= 新 provider 追加時の安全側 fallback)。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  native: "TenkaCloud",
  sakura: "Sakura Cloud",
  azure: "Azure",
  gcp: "Google Cloud",
};

/** 表示名を引く。未知 provider は raw 値 fallback (prototype 連鎖は引かない)。 */
export function providerLabel(provider: string): string {
  return Object.hasOwn(PROVIDER_LABEL, provider) ? PROVIDER_LABEL[provider] : provider;
}

/**
 * ParticipantProblemView の provider を backend の resolveViewProvider と同じ規則で解決する:
 * provider 欠落 / 空 = aws (旧 backend 応答 / legacy 行との互換)。
 */
interface RuntimeProviderView {
  readonly provider?: string;
  readonly runtimeKind?: string;
  readonly coordination?: boolean;
}

export function problemProvider(problem: RuntimeProviderView): string {
  if (problem.runtimeKind === "coordination" || problem.coordination === true) return "native";
  return typeof problem.provider === "string" && problem.provider !== "" ? problem.provider : "aws";
}

/**
 * Issue #2235: external-portal capability の宛先。プラットフォーム所有の
 * 定数マップ — problem metadata / 参加者入力からは供給しない (= redirect vector を
 * 作らない)。公開コンソールのサインインページなので問題情報の漏えいも無い。
 * aws はここに載せない (managed console 経路 = SSO federation を使う)。
 */
export const EXTERNAL_PORTAL_URL: Record<string, string> = {
  gcp: "https://console.cloud.google.com/",
  azure: "https://portal.azure.com/",
  sakura: "https://secure.sakura.ad.jp/cloud/",
};

/** external-portal の宛先 URL。マップ外 (aws / 未知 provider) は undefined (prototype 連鎖は引かない)。 */
export function externalPortalUrl(provider: string): string | undefined {
  return Object.hasOwn(EXTERNAL_PORTAL_URL, provider) ? EXTERNAL_PORTAL_URL[provider] : undefined;
}

/** Explicit capabilities are authoritative; an omitted list preserves the old backend contract. */
export function hasAwsAccessCapability(
  problem: RuntimeProviderView & { readonly accessCapabilities?: readonly string[] },
  capability: "console" | "cli-credentials",
): boolean {
  if (problemProvider(problem) !== "aws") return false;
  return (
    problem.accessCapabilities === undefined ||
    (Array.isArray(problem.accessCapabilities) && problem.accessCapabilities.includes(capability))
  );
}
