/**
 * Auth0 Management API Client
 *
 * Auth0 Management API との通信を担当するクライアント。
 * 環境変数から設定を読み込み、トークンキャッシュを管理。
 */

import type {
  Auth0Config,
  Auth0TokenResponse,
  Auth0Organization,
  Auth0User,
  Auth0OrganizationMember,
  Logger,
} from './types';
import { defaultLogger } from './types';

// =============================================================================
// Configuration
// =============================================================================

function validateConfig(): Auth0Config {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;

  if (nodeEnv === 'production' && (!domain || !clientId || !clientSecret)) {
    throw new Error(
      'AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET are required in production'
    );
  }

  return {
    domain: domain || 'dev-tenkacloud.auth0.com',
    clientId: clientId || 'test-client-id',
    clientSecret: clientSecret || 'test-client-secret',
    audience: `https://${domain || 'dev-tenkacloud.auth0.com'}/api/v2/`,
  };
}

// =============================================================================
// Auth0 Client Class
// =============================================================================

export class Auth0Client {
  private config: Auth0Config;
  private logger: Logger;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(config?: Partial<Auth0Config>, logger?: Logger) {
    const validatedConfig = validateConfig();
    this.config = {
      ...validatedConfig,
      ...config,
    };
    this.logger = logger ?? defaultLogger;
  }

  // ---------------------------------------------------------------------------
  // Token Management
  // ---------------------------------------------------------------------------

  private async getManagementToken(): Promise<string> {
    const now = Date.now();

    if (this.cachedToken && this.cachedToken.expiresAt > now + 60000) {
      return this.cachedToken.token;
    }

    try {
      const response = await fetch(
        `https://${this.config.domain}/oauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            audience: this.config.audience,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `Auth0 token request failed: ${response.status} ${error}`
        );
      }

      const data = (await response.json()) as Auth0TokenResponse;
      this.cachedToken = {
        token: data.access_token,
        expiresAt: now + data.expires_in * 1000,
      };

      this.logger.info('Auth0 Management API トークンを取得しました');
      return this.cachedToken.token;
    } catch (error) {
      this.logger.error({ error }, 'Auth0 トークン取得に失敗しました');
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // API Request Helper
  // ---------------------------------------------------------------------------

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = await this.getManagementToken();

    const response = await fetch(
      `https://${this.config.domain}/api/v2${path}`,
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: { message?: string; error?: string } = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }
      throw new Error(
        `Auth0 API error: ${response.status} ${errorData.message || errorData.error || errorText}`
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Organization Operations
  // ---------------------------------------------------------------------------

  async createOrganization(
    name: string,
    displayName: string,
    metadata?: Record<string, string>
  ): Promise<Auth0Organization> {
    try {
      const org = await this.request<Auth0Organization>('/organizations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          display_name: displayName,
          metadata,
        }),
      });

      this.logger.info({ orgId: org.id, name }, 'Organization を作成しました');
      return org;
    } catch (error) {
      if (error instanceof Error && error.message.includes('409')) {
        this.logger.info({ name }, 'Organization は既に存在します');
        const org = await this.getOrganizationByName(name);
        if (org) return org;
      }
      this.logger.error({ error, name }, 'Organization 作成に失敗しました');
      throw error;
    }
  }

  async getOrganization(orgId: string): Promise<Auth0Organization | null> {
    try {
      return await this.request<Auth0Organization>(`/organizations/${orgId}`);
    } catch {
      return null;
    }
  }

  async getOrganizationByName(name: string): Promise<Auth0Organization | null> {
    try {
      return await this.request<Auth0Organization>(
        `/organizations/name/${name}`
      );
    } catch {
      return null;
    }
  }

  async deleteOrganization(orgId: string): Promise<void> {
    try {
      await this.request(`/organizations/${orgId}`, {
        method: 'DELETE',
      });
      this.logger.info({ orgId }, 'Organization を削除しました');
    } catch (error) {
      this.logger.error({ error, orgId }, 'Organization 削除に失敗しました');
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // User Operations
  // ---------------------------------------------------------------------------

  async createUser(
    email: string,
    name: string,
    password: string,
    connection: string = 'Username-Password-Authentication'
  ): Promise<Auth0User> {
    try {
      const user = await this.request<Auth0User>('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          name,
          password,
          connection,
          email_verified: false,
          verify_email: true,
        }),
      });

      this.logger.info(
        { userId: user.user_id, email },
        'ユーザーを作成しました'
      );
      return user;
    } catch (error) {
      this.logger.error({ error, email }, 'ユーザー作成に失敗しました');
      throw error;
    }
  }

  async getUserByEmail(email: string): Promise<Auth0User | null> {
    try {
      const users = await this.request<Auth0User[]>(
        `/users-by-email?email=${encodeURIComponent(email)}`
      );
      return users[0] || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Organization Member Operations
  // ---------------------------------------------------------------------------

  async addMemberToOrganization(orgId: string, userId: string): Promise<void> {
    try {
      await this.request(`/organizations/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify({ members: [userId] }),
      });

      this.logger.info(
        { orgId, userId },
        'ユーザーを Organization に追加しました'
      );
    } catch (error) {
      this.logger.error(
        { error, orgId, userId },
        'Organization へのメンバー追加に失敗しました'
      );
      throw error;
    }
  }

  async getOrganizationMembers(
    orgId: string
  ): Promise<Auth0OrganizationMember[]> {
    try {
      return await this.request<Auth0OrganizationMember[]>(
        `/organizations/${orgId}/members`
      );
    } catch {
      return [];
    }
  }

  async assignRolesToMember(
    orgId: string,
    userId: string,
    roleIds: string[]
  ): Promise<void> {
    try {
      await this.request(`/organizations/${orgId}/members/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roles: roleIds }),
      });

      this.logger.info({ orgId, userId, roleIds }, 'ロールを割り当てました');
    } catch (error) {
      this.logger.error(
        { error, orgId, userId, roleIds },
        'ロール割り当てに失敗しました'
      );
      throw error;
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultClient: Auth0Client | null = null;

export function getAuth0Client(logger?: Logger): Auth0Client {
  if (!defaultClient) {
    defaultClient = new Auth0Client(undefined, logger);
  }
  return defaultClient;
}

/**
 * テスト用にクライアントをリセット
 */
export function resetAuth0Client(): void {
  defaultClient = null;
}
