'use client';

import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth/auth-context';

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (session) router.replace('/dashboard');
  }, [session, router]);

  return (
    <div
      className="awsui-dark-mode"
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: '420px' }}>
        <Container
          header={
            <Header
              variant="h1"
              description="プラットフォーム管理者向けコンソール"
            >
              TenkaCloud Control Plane
            </Header>
          }
        >
          <SpaceBetween size="l">
            <button
              type="button"
              onClick={() => signIn()}
              className="awsui-button awsui-button-variant-primary"
              style={{
                width: '100%',
                padding: '8px 20px',
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 700,
                backgroundColor:
                  'var(--color-background-button-primary-default, #539fe5)',
                color: 'var(--color-text-button-primary-default, #0f1b2d)',
              }}
            >
              ログイン
            </button>
            <Box
              textAlign="center"
              color="text-body-secondary"
              fontSize="body-s"
            >
              AWS Cognito で認証します
            </Box>
          </SpaceBetween>
        </Container>
      </div>
    </div>
  );
}
