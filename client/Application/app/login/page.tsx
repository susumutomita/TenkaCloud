/**
 * Login Page
 *
 * Cloudscape Design System — ログインページ
 */

import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import '@cloudscape-design/global-styles/index.css';
import { loginWithAuth0 } from './actions';

export default function LoginPage() {
  return (
    <div
      className="awsui-dark-mode flex min-h-screen items-center justify-center"
      style={{ background: 'var(--color-background-layout-main)' }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <Container
          header={
            <Header
              variant="h1"
              description="クラウド天下一武道会 — 競技者ポータル"
            >
              TenkaCloud
            </Header>
          }
        >
          <SpaceBetween size="m">
            <form action={loginWithAuth0}>
              <button
                type="submit"
                className="awsui-button awsui-button-variant-primary"
                style={{
                  width: '100%',
                  padding: '8px 20px',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: 14,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Auth0 でログイン
              </button>
            </form>
            <Box variant="small" textAlign="center" color="text-body-secondary">
              ログイン後、バトルに参加して AWS Console にアクセスできます
            </Box>
          </SpaceBetween>
        </Container>
      </div>
    </div>
  );
}
