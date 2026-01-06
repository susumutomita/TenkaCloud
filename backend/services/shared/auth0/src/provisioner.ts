/**
 * Auth0 Tenant Provisioner
 *
 * テナントプロビジョニング時に Auth0 Organization を作成するプロビジョナー。
 * LocalStack 環境では Auth0 呼び出しをスキップして mock を返す。
 */

import type {
  Auth0ProvisionerResult,
  Auth0ProvisionerOptions,
  Logger,
} from './types';
import { defaultLogger } from './types';
import { Auth0Client, getAuth0Client } from './client';

export class Auth0Provisioner {
  private client: Auth0Client;
  private logger: Logger;
  private skipAuth0: boolean;

  constructor(options?: Auth0ProvisionerOptions, logger?: Logger) {
    this.logger = logger ?? defaultLogger;
    this.client = getAuth0Client(this.logger);

    // LocalStack や開発環境では Auth0 をスキップ
    const isLocalStack =
      process.env.AWS_ENDPOINT_URL?.includes('localhost') ||
      process.env.AWS_ENDPOINT_URL?.includes('localstack');
    this.skipAuth0 = options?.skipAuth0 ?? isLocalStack ?? false;

    if (this.skipAuth0) {
      this.logger.info('Auth0 provisioning をスキップモードで初期化しました');
    }
  }

  /**
   * テナント用の Auth0 Organization を作成
   *
   * @param tenantSlug - テナントスラッグ（URL 用識別子）
   * @param tenantName - テナント表示名
   * @param tier - 料金プラン (FREE/PRO/ENTERPRISE)
   * @returns Organization ID と名前
   */
  async createTenantOrganization(
    tenantSlug: string,
    tenantName: string,
    tier: string
  ): Promise<Auth0ProvisionerResult> {
    const orgName = `tenant-${tenantSlug}`;

    // LocalStack モードでは mock を返す
    if (this.skipAuth0) {
      this.logger.info(
        { orgName, tier },
        'Auth0 スキップモード: mock Organization を返します'
      );
      return {
        organizationId: `org_mock_${tenantSlug}`,
        organizationName: orgName,
      };
    }

    try {
      // 既存の Organization を確認
      const existingOrg = await this.client.getOrganizationByName(orgName);

      if (existingOrg) {
        this.logger.info({ orgName }, 'Organization は既に存在します');
        return {
          organizationId: existingOrg.id,
          organizationName: existingOrg.name,
        };
      }

      // 新規 Organization を作成
      const org = await this.client.createOrganization(orgName, tenantName, {
        tenant_slug: tenantSlug,
        tier,
      });

      this.logger.info(
        { organizationId: org.id, orgName },
        'Organization を作成しました'
      );

      return {
        organizationId: org.id,
        organizationName: org.name,
      };
    } catch (error) {
      this.logger.error(
        { error, tenantSlug, tenantName },
        'Organization の作成に失敗しました'
      );
      throw error;
    }
  }

  /**
   * テナント用の Auth0 Organization を削除
   *
   * @param tenantSlug - テナントスラッグ
   */
  async deleteTenantOrganization(tenantSlug: string): Promise<void> {
    const orgName = `tenant-${tenantSlug}`;

    if (this.skipAuth0) {
      this.logger.info(
        { orgName },
        'Auth0 スキップモード: Organization 削除をスキップします'
      );
      return;
    }

    try {
      const org = await this.client.getOrganizationByName(orgName);

      if (!org) {
        this.logger.info({ orgName }, 'Organization は存在しません');
        return;
      }

      await this.client.deleteOrganization(org.id);
      this.logger.info({ orgName }, 'Organization を削除しました');
    } catch (error) {
      this.logger.error(
        { error, tenantSlug },
        'Organization の削除に失敗しました'
      );
      throw error;
    }
  }

  /**
   * テナント Organization にメンバーを追加
   *
   * @param tenantSlug - テナントスラッグ
   * @param userId - Auth0 ユーザー ID
   */
  async addMemberToTenant(tenantSlug: string, userId: string): Promise<void> {
    const orgName = `tenant-${tenantSlug}`;

    if (this.skipAuth0) {
      this.logger.info(
        { orgName, userId },
        'Auth0 スキップモード: メンバー追加をスキップします'
      );
      return;
    }

    try {
      const org = await this.client.getOrganizationByName(orgName);

      if (!org) {
        throw new Error(`Organization not found: ${orgName}`);
      }

      await this.client.addMemberToOrganization(org.id, userId);
      this.logger.info({ orgName, userId }, 'ユーザーをテナントに追加しました');
    } catch (error) {
      this.logger.error(
        { error, tenantSlug, userId },
        'テナントへのメンバー追加に失敗しました'
      );
      throw error;
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

let defaultProvisioner: Auth0Provisioner | null = null;

export function getAuth0Provisioner(
  options?: Auth0ProvisionerOptions,
  logger?: Logger
): Auth0Provisioner {
  if (!defaultProvisioner) {
    defaultProvisioner = new Auth0Provisioner(options, logger);
  }
  return defaultProvisioner;
}

/**
 * テスト用にプロビジョナーをリセット
 */
export function resetAuth0Provisioner(): void {
  defaultProvisioner = null;
}
