import type { Tenant, TenantTier } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { createAdminUser } from '../lib/auth0';
import {
  createNotificationService,
  type NotificationService,
} from './notification';
import { ProvisioningManager } from '../provisioning/manager';

const logger = createLogger('registration-service');

export interface RegistrationInput {
  organizationName: string;
  adminEmail: string;
  adminName: string;
  tier?: TenantTier;
}

export interface RegistrationResult {
  tenantId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  message: string;
}

export class RegistrationService {
  private notificationService: NotificationService;
  private provisioningManager: ProvisioningManager;

  constructor(
    notificationService?: NotificationService,
    provisioningManager?: ProvisioningManager
  ) {
    this.notificationService =
      notificationService ?? createNotificationService();
    this.provisioningManager = provisioningManager ?? new ProvisioningManager();
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    logger.info(
      {
        organizationName: input.organizationName,
        adminEmail: input.adminEmail,
      },
      'テナント登録を開始します'
    );

    // Generate unique slug from organization name
    const slug = this.generateSlug(input.organizationName);

    // Create tenant record
    const tenant = await prisma.tenant.create({
      data: {
        name: input.organizationName,
        slug,
        adminEmail: input.adminEmail,
        adminName: input.adminName,
        tier: input.tier ?? 'FREE',
        status: 'ACTIVE',
        provisioningStatus: 'PENDING',
      },
    });

    logger.info(
      { tenantId: tenant.id, slug },
      'テナントレコードを作成しました'
    );

    // Start provisioning asynchronously
    this.startProvisioningAsync(tenant);

    return {
      tenantId: tenant.id,
      status: 'PENDING',
      message:
        '登録を受け付けました。プロビジョニング完了後にメールでお知らせします。',
    };
  }

  private async startProvisioningAsync(tenant: Tenant): Promise<void> {
    try {
      logger.info({ tenantId: tenant.id }, 'プロビジョニングを開始します');

      // Run provisioning
      await this.provisioningManager.provisionTenant(tenant);

      // Get updated tenant status
      const updatedTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
      });

      if (!updatedTenant) {
        throw new Error('テナントが見つかりません');
      }

      if (updatedTenant.provisioningStatus === 'COMPLETED') {
        // Create admin user in Auth0 Organization
        const orgName = `tenant-${updatedTenant.slug}`;
        const credentials = await createAdminUser(
          orgName,
          updatedTenant.adminEmail,
          updatedTenant.adminName || updatedTenant.adminEmail
        );

        // Send success notification
        await this.notificationService.sendRegistrationComplete(updatedTenant, {
          email: updatedTenant.adminEmail,
          temporaryPassword: credentials.temporaryPassword,
        });

        logger.info({ tenantId: tenant.id }, 'プロビジョニングが完了しました');
      } else if (updatedTenant.provisioningStatus === 'FAILED') {
        await this.notificationService.sendRegistrationFailed(
          updatedTenant,
          'プロビジョニング処理中にエラーが発生しました'
        );
      }
    } catch (error) {
      logger.error(
        { error, tenantId: tenant.id },
        'プロビジョニングに失敗しました'
      );

      // Update tenant status to FAILED
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { provisioningStatus: 'FAILED' },
      });

      // Send failure notification
      const errorMessage =
        error instanceof Error ? error.message : '不明なエラーが発生しました';
      await this.notificationService.sendRegistrationFailed(
        tenant,
        errorMessage
      );
    }
  }

  async getRegistrationStatus(
    tenantId: string
  ): Promise<{ tenant: Tenant } | null> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      return null;
    }

    return { tenant };
  }

  private generateSlug(name: string): string {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    // Add timestamp suffix for uniqueness
    const timestamp = Date.now().toString(36);
    return `${baseSlug}-${timestamp}`;
  }
}
