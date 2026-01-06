/**
 * @tenkacloud/auth0
 *
 * Auth0 Management API 型定義
 */

// =============================================================================
// Configuration
// =============================================================================

export interface Auth0Config {
  /** Auth0 テナントドメイン (例: dev-tenkacloud.auth0.com) */
  domain: string;
  /** Management API クライアント ID */
  clientId: string;
  /** Management API クライアントシークレット */
  clientSecret: string;
  /** Management API audience */
  audience: string;
}

// =============================================================================
// Auth0 API Response Types
// =============================================================================

export interface Auth0TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface Auth0Organization {
  id: string;
  name: string;
  display_name: string;
  branding?: {
    logo_url?: string;
    colors?: {
      primary?: string;
      page_background?: string;
    };
  };
  metadata?: Record<string, string>;
}

export interface Auth0User {
  user_id: string;
  email: string;
  name: string;
  nickname?: string;
  picture?: string;
  created_at: string;
}

export interface Auth0OrganizationMember {
  user_id: string;
  email: string;
  name: string;
  roles?: { id: string; name: string }[];
}

// =============================================================================
// Provisioner Types
// =============================================================================

export interface Auth0ProvisionerResult {
  /** Auth0 Organization ID */
  organizationId: string;
  /** Auth0 Organization name (tenant-{slug}) */
  organizationName: string;
}

export interface Auth0ProvisionerOptions {
  /** LocalStack モードの場合は Auth0 呼び出しをスキップ */
  skipAuth0?: boolean;
}

// =============================================================================
// Logger Interface
// =============================================================================

export interface Logger {
  info: (data: Record<string, unknown> | string, message?: string) => void;
  error: (data: Record<string, unknown> | string, message?: string) => void;
  debug?: (data: Record<string, unknown> | string, message?: string) => void;
}

/**
 * デフォルトのコンソールロガー
 */
export const defaultLogger: Logger = {
  info: (data, message) => {
    if (typeof data === 'string') {
      console.log(`[INFO] ${data}`);
    } else {
      console.log(`[INFO] ${message ?? ''}`, data);
    }
  },
  error: (data, message) => {
    if (typeof data === 'string') {
      console.error(`[ERROR] ${data}`);
    } else {
      console.error(`[ERROR] ${message ?? ''}`, data);
    }
  },
  debug: (data, message) => {
    if (process.env.DEBUG) {
      if (typeof data === 'string') {
        console.log(`[DEBUG] ${data}`);
      } else {
        console.log(`[DEBUG] ${message ?? ''}`, data);
      }
    }
  },
};
