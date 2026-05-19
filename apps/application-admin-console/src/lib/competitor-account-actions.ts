/**
 * Issue #1054: Competitor Accounts 画面の row 単位 button guard。
 *
 * backend (`competitor-accounts-handler/index.ts:313-317`, Issue #868) は verified=false な row
 * への Rotate ExternalId を 409 not_verified で reject する。 UI が状態に追従していないと、
 * operator は button を click してから 409 を画面で見るハマり方をする。 ここを pure function に
 * 切り出して、 JSX 側で `disabled` の引数として渡し、 同時に unit test で挙動を pin する。
 */

export interface RotateButtonGuardInput {
  readonly verified: boolean;
  /** 同画面で進行中の verify があれば awsAccountId、 無ければ null。 */
  readonly verifyInFlight: string | null;
}

export const ROTATE_DISABLED_REASON_NOT_VERIFIED =
  "先に Verify を成功させてから Rotate してください。";
export const ROTATE_DISABLED_REASON_VERIFY_IN_FLIGHT =
  "Verify 中は Rotate できません。 完了を待ってください。";

export interface RotateButtonGuardResult {
  readonly disabled: boolean;
  /** disabled=true のときに HTML `title` 属性 / Popover content として表示する文言。 */
  readonly reason: string | undefined;
}

export function evaluateRotateButtonGuard(input: RotateButtonGuardInput): RotateButtonGuardResult {
  if (!input.verified) {
    return { disabled: true, reason: ROTATE_DISABLED_REASON_NOT_VERIFIED };
  }
  if (input.verifyInFlight !== null) {
    return { disabled: true, reason: ROTATE_DISABLED_REASON_VERIFY_IN_FLIGHT };
  }
  return { disabled: false, reason: undefined };
}
