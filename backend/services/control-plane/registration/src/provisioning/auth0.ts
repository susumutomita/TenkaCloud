import { createOrganization, getOrganizationByName } from '../lib/auth0';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth0-provisioner');

export interface Auth0ProvisionerResult {
  organizationId: string;
  organizationName: string;
}

export class Auth0Provisioner {
  async createTenantOrganization(
    tenantSlug: string,
    tenantName: string,
    tier: string
  ): Promise<Auth0ProvisionerResult> {
    const orgName = `tenant-${tenantSlug}`;

    try {
      const existingOrg = await getOrganizationByName(orgName);

      if (existingOrg) {
        logger.info({ orgName }, 'Organization は既に存在します');
        return {
          organizationId: existingOrg.id,
          organizationName: existingOrg.name,
        };
      }

      const org = await createOrganization(orgName, tenantName, {
        tenant_slug: tenantSlug,
        tier,
      });

      logger.info(
        { organizationId: org.id, orgName },
        'Organization を作成しました'
      );

      return {
        organizationId: org.id,
        organizationName: org.name,
      };
    } catch (error) {
      logger.error(
        { error, tenantSlug, tenantName },
        'Organization の作成に失敗しました'
      );
      throw error;
    }
  }
}
