'use client';

import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { completeLogin } from '@/lib/auth/cognito-pkce';
import { loadConfig } from '@/lib/runtime-config';

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackInner />
    </Suspense>
  );
}

function CallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state') ?? undefined;
    const oauthError = searchParams.get('error');

    if (oauthError) {
      setError(`Cognito returned an error: ${oauthError}`);
      return;
    }

    if (!code) {
      setError('Authorization code missing from callback URL');
      return;
    }

    void (async () => {
      try {
        const config = await loadConfig();
        const tokens = await completeLogin(config, code, state);
        setTokens(tokens);
        router.replace('/dashboard');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [router, searchParams, setTokens]);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: '480px' }}>
        <Container header={<Header variant="h1">ログイン処理中</Header>}>
          {error ? (
            <Box>
              <StatusIndicator type="error">エラー</StatusIndicator>
              <Box variant="p" margin={{ top: 's' }}>
                {error}
              </Box>
              <Box variant="p" margin={{ top: 's' }}>
                <a href="/login">ログイン画面に戻る</a>
              </Box>
            </Box>
          ) : (
            <StatusIndicator type="loading">
              認証コードを交換中…
            </StatusIndicator>
          )}
        </Container>
      </div>
    </div>
  );
}
