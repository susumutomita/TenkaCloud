import type { AssumeRoleStage, AwsAccessOperation } from "./types";

/**
 * Portal API 共通 error classes。 caller (= UI / hook) は instanceof で振り分けて
 * lock screen / inline error / generic error を出し分ける。
 *
 * Class identity の互換性: ファイル分割前後で `import { PortalAuthError } from
 * "../api/portal-client"` の identity が変わらないように façade index.ts で re-export する。
 */

export class PortalValidationError extends Error {
  /**
   * Issue #1315: 400 / 409 で backend が `error` 以外の付加 field (例: `missingHintId`) を
   * 返すケース向けの optional 受け皿。 UI 側で error 種別ごとに必要な field を引き出して
   * 親切メッセージを組み立てる (= 各 error 種別ごとに sub-class を量産しない軽量解)。
   */
  constructor(
    public readonly errorCode: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super("入力値が不正です。");
    this.name = "PortalValidationError";
  }
}

export class PortalAuthError extends Error {
  constructor() {
    super("チームログインキーが無効か、デプロイが既に削除されています。");
    this.name = "PortalAuthError";
  }
}

export class PortalNetworkError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Portal API ${status}: ${body || "unknown"}`);
    this.name = "PortalNetworkError";
  }
}

/**
 * Issue #1006: scoring gate (= 競技開始前 / 終了後) で 409 が返った時に、 startsAt / endsAt を
 * 取り出して UI が 「競技開始まで N 分」 「競技は X 終了しました」 を出せるようにする。
 *
 * backend は { error: "scoring_not_started"|"scoring_ended", startsAt?, endsAt? } を返す。
 * 旧来 frontend は PortalNetworkError として string で受け取り、 ユーザーに JSON が見える
 * 不親切 UX だった。
 */
export class PortalScoringGateError extends Error {
  constructor(
    public readonly kind: "scoring_not_started" | "scoring_ended" | "scoring_locked",
    public readonly startsAt?: string,
    public readonly endsAt?: string,
  ) {
    super(`Portal scoring gate: ${kind}`);
    this.name = "PortalScoringGateError";
  }
}

/**
 * Retains the legacy stage/reason error contract. New responses also identify the
 * failed AWS API: competitor-stage verification includes SSM and CloudFormation.
 * Viewer AssumeRole uses operator credentials with the deployment job ExternalId.
 */
export class PortalAssumeRoleError extends Error {
  constructor(
    public readonly stage: AssumeRoleStage,
    public readonly reason: string,
    public readonly operation?: AwsAccessOperation,
  ) {
    super(`Portal AssumeRole failed (${stage}): ${reason}`);
    this.name = "PortalAssumeRoleError";
  }
}
