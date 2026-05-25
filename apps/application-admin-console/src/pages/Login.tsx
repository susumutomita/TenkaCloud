/**
 * Issue #1329: Tenant Admin (application-admin-console) のログイン画面。 LP と同じ
 * branding を適用し、 「Application Admin Console」 + dev jargon の文言を商用 SaaS
 * のログイン画面へ refresh。
 *
 * 表示状態:
 *   1) idle     : title + subtitle + 「サインイン」 button
 *   2) signing  : Cognito へ redirect 中 spinner
 *   3) error    : beginLogin throw 時の fallback alert + mailto link
 */

import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ProductLoginShell } from "../components/ProductLoginShell";
import { useT } from "../i18n";

export function LoginPage() {
  const auth = useAuth();
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const onSignIn = async () => {
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

  return (
    <ProductLoginShell
      title={t("login.title")}
      subtitle={t("login.subtitle")}
      signInLabel={t("login.sign_in_button")}
      signingInLabel={t("login.signing_in")}
      signingIn={signingIn}
      errorMessage={errorMessage}
      onSignIn={onSignIn}
    />
  );
}
