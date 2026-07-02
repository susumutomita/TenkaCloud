/**
 * Issue #2201: SBT tenant onboarding / offboarding event の detail-type の単一 source of
 * truth。 旧状態は EventBridge Rule のフィルタ (system-audit-writer-lambda.ts) と handler の
 * 対応表 (index.ts) が同じ 6 リテラルを別々に持ち、 片方だけ更新すると 「配信されるが監査
 * されない」 / 「フィルタで落ちて届かない」 が無音で起きる構造だった。
 *
 * detail-type 自体は SBT (`@cdklabs/sbt-aws` の event-manager) が発する外部契約なので、
 * 追加・改名するときは SBT 側の DetailType enum と突き合わせること。
 */
export const SBT_ONBOARDING_DETAIL_TYPES = [
  "onboardingRequest",
  "onboardingSuccess",
  "onboardingFailure",
  "offboardingRequest",
  "offboardingSuccess",
  "offboardingFailure",
] as const;

export type SbtOnboardingDetailType = (typeof SBT_ONBOARDING_DETAIL_TYPES)[number];

export function isSbtOnboardingDetailType(value: string): value is SbtOnboardingDetailType {
  return (SBT_ONBOARDING_DETAIL_TYPES as readonly string[]).includes(value);
}
