/**
 * Issue #1329: Tenant Admin (application-admin-console) のログイン画面。 LP と同じ
 * branding を適用し、 「Application Admin Console」 + dev jargon の文言を商用 SaaS
 * のログイン画面へ refresh。
 *
 * Issue #1360: SAML IdP picker を表示する余地が application-admin-console には存在
 * しない (= tenant の Cognito UserPool は SAML を直接持たない / pooled 共有 UserPool)
 * ため、 中間 「サインイン」 button は常に冗長な 1 click でしかなかった。 Mount 直後に
 * `beginLogin()` を発火させて Cognito Hosted UI に直接 redirect する。
 *
 * 表示状態:
 *   1) signing  : Cognito へ redirect 中 spinner (= 初期状態)
 *   2) error    : beginLogin throw 時の fallback alert + mailto link
 *                 (= button を再表示し再 sign-in 試行を許可)
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ProductLoginShell } from "../components/ProductLoginShell";
import { useT } from "../i18n";

export function LoginPage() {
  const auth = useAuth();
  const t = useT();
  // mount 直後に auto-redirect を 1 回だけ走らせる guard。 React StrictMode の 2 度
  // mount / re-render での重複発火を防ぐ。 error 発生時は user 操作で再試行できるよう
  // この flag は触らず、 button の onSignIn から再度 `signIn` を呼ぶ経路に倒す。
  const autoStartedRef = useRef(false);
  const [signingIn, setSigningIn] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const signIn = async () => {
    setSigningIn(true);
    setErrorMessage(undefined);
    try {
      await auth.login();
      // 成功時は Cognito Hosted UI への redirect で browser が unload されるため到達せず。
    } catch (err) {
      setSigningIn(false);
      setErrorMessage(
        `${t("login.error_body")} ${err instanceof Error ? err.message : ""} ${t(
          "login.support_contact",
        )}`,
      );
    }
  };

  // SAML 候補なし → mount 即 Cognito へ。 error からの再試行は button で。 signIn を
  // 依存に入れると毎 render で hook 再評価されるため空 array に固定し、 重複発火は
  // autoStartedRef で 1 度に絞り込む (Issue #1360)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above (#1360).
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void signIn();
  }, []);

  return (
    <ProductLoginShell
      title={t("login.title")}
      subtitle={t("login.subtitle")}
      signInLabel={t("login.sign_in_button")}
      signingInLabel={t("login.signing_in")}
      signingIn={signingIn}
      errorMessage={errorMessage}
      onSignIn={signIn}
    />
  );
}
