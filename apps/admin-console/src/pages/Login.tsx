/**
 * Issue #1329: System Admin (admin-console) のログイン画面。 LP と同じ branding を
 * 適用し、 「dev 感のある heading + 灰色 box」 から商用 SaaS のログイン画面へ refresh。
 *
 * 表示状態:
 *   1) idle     : title + subtitle + 「サインイン」 button
 *   2) signing  : Cognito へ redirect 中 spinner (= window.location.assign 直前)
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
      // 成功時は Cognito Hosted UI への redirect が走るため、 ここに到達しない (= browser
      // が unload される)。 finally の setSigningIn(false) を打つと redirect 直前に
      // button が一瞬戻ってしまう UX 劣化があるため、 成功 path では state を保持。
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
