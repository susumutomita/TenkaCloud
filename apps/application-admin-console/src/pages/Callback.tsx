import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";
import { completeLogin } from "@tenkacloud/auth-client";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { consumeLoginReturnPath } from "../auth/login-return-path";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

export function CallbackPage({ config }: { config: AppConfig }) {
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    const code = params.get("code");
    const state = params.get("state") ?? undefined;
    if (!code) {
      setError(t("callback.missing_code"));
      return;
    }
    completeLogin(config, code, state)
      .then((tokens) => {
        auth.setTokens(tokens);
        navigate(consumeLoginReturnPath(), { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  }, [params, config, auth, navigate, t]);

  if (error) {
    return (
      <Box margin={{ top: "xxxl" }}>
        <Alert type="error" header={t("callback.signin_failed_header")}>
          {error}
        </Alert>
      </Box>
    );
  }

  return (
    <Box margin={{ top: "xxxl" }} textAlign="center">
      <Spinner size="large" />
      <Box variant="p" margin={{ top: "m" }}>
        {t("callback.confirming")}
      </Box>
    </Box>
  );
}
