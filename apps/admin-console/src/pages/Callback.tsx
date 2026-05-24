import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";
import { completeLogin } from "@tenkacloud/auth-client";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

export function CallbackPage({ config }: { config: AppConfig }) {
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    const code = params.get("code");
    const state = params.get("state") ?? undefined;
    if (!code) {
      setError("Authorization code がリダイレクト URL に見つかりません。");
      return;
    }
    completeLogin(config, code, state)
      .then((tokens) => {
        auth.setTokens(tokens);
        navigate("/tenants", { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  }, [params, config, auth, navigate]);

  if (error) {
    return (
      <Box margin={{ top: "xxxl" }}>
        <Alert type="error" header="サインインに失敗しました">
          {error}
        </Alert>
      </Box>
    );
  }

  return (
    <Box margin={{ top: "xxxl" }} textAlign="center">
      <Spinner size="large" />
      <Box variant="p" margin={{ top: "m" }}>
        サインインを確定しています…
      </Box>
    </Box>
  );
}
