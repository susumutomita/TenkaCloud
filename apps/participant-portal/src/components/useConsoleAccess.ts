import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useState } from "react";
import {
  getConsoleSigninUrl,
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";

type TranslateFn = (key: string, vars?: Record<string, string>) => string;

/**
 * 「Console 開く」 ボタン押下時の error → 表示文字列 / 動作 への変換。
 * 戻り値が `"auth_logout"` のときは 「session 期限切れにつき logout する」 シグナル。
 * それ以外の文字列は Alert に出すメッセージ。
 */
export function describeOpenConsoleError(err: unknown, t: TranslateFn): string {
  if (err instanceof PortalAuthError) return "auth_logout";
  if (err instanceof PortalAssumeRoleError) {
    // Issue #1197: stage を翻訳して 「どちらの段が落ちたか」 を表示する。
    return t("sso_credentials.cli.assume_role_failed", {
      stage: t(`sso_credentials.cli.stage_${err.stage}`),
      reason: err.reason,
    });
  }
  if (err instanceof PortalValidationError) {
    return t("sso_credentials.validation_error", { errorCode: err.errorCode });
  }
  return toErrorMessage(err);
}

export interface ConsoleAccessError {
  readonly message: string;
  /** mock mode で blocked になったときの info 表示用 (= 赤 error にしない)。 */
  readonly isMock: boolean;
}

export interface ConsoleAccess {
  /** 指定 problem の AWS Console ワンクリック login を新タブで開く。 */
  readonly openConsole: (jobId: string) => Promise<void>;
  /** 開いている最中の jobId (= 多重起動防止 + ボタン loading 表示用)。 */
  readonly pending: string | null;
  readonly error: ConsoleAccessError | null;
  readonly dismissError: () => void;
}

/**
 * AWS Console ワンクリック login の共有 hook。SSO Credentials ページと TopNavigation の
 * 常設 Console 導線 (Issue #1919) が同じロジックを使う (= 重複排除)。
 *
 * 競技者は自前 AWS ログイン不要で、button を押すと backend Lambda が STS AssumeRole +
 * signin federation を実行して `signin.aws.amazon.com/federation?Action=login` URL を
 * 発行 → 新タブで開く。Lambda が assume するのは `ConsoleViewerRole` (= ReadOnlyAccess)。
 */
export function useConsoleAccess(config: AppConfig): ConsoleAccess {
  const auth = useAuth();
  const t = useT();
  const isMock = useIsMock();
  const sessionToken = auth.session?.sessionToken ?? null;

  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ConsoleAccessError | null>(null);

  const dismissError = useCallback(() => setError(null), []);

  const openConsole = useCallback(
    async (jobId: string) => {
      if (!sessionToken || pending) return;
      // dev-mock mode: backend を呼ぶと localhost への fetch が "Failed to fetch" になるため、
      // 試行せず info メッセージで「モックでは AWS Console を開けません」 を表示する (= LP demo
      // 訪問者が clicked して赤い error alert に驚かないようにする)。
      if (isMock) {
        setError({ message: t("sso_credentials.mock_open_blocked"), isMock: true });
        return;
      }
      setPending(jobId);
      setError(null);
      try {
        const loginUrl = await getConsoleSigninUrl(config.apiBaseUrl, sessionToken, jobId);
        window.open(loginUrl, "_blank", "noopener,noreferrer");
      } catch (err) {
        const message = describeOpenConsoleError(err, t);
        if (message === "auth_logout") {
          auth.logout();
          return;
        }
        setError({ message, isMock: false });
      } finally {
        setPending(null);
      }
    },
    [sessionToken, pending, isMock, t, config.apiBaseUrl, auth],
  );

  return { openConsole, pending, error, dismissError };
}
