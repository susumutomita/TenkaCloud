import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { Auth0Provisioner } from './auth0';
import { KubernetesProvisioner } from './kubernetes';
import type { Tenant } from '@prisma/client';

const logger = createLogger('provisioning-manager');

export interface ProvisioningManagerDeps {
  auth0Provisioner?: Auth0Provisioner;
  k8sProvisioner?: KubernetesProvisioner;
}

export class ProvisioningManager {
  private auth0Provisioner: Auth0Provisioner;
  private k8sProvisioner: KubernetesProvisioner | null;

  constructor(deps?: ProvisioningManagerDeps) {
    this.auth0Provisioner = deps?.auth0Provisioner ?? new Auth0Provisioner();
    this.k8sProvisioner = deps?.k8sProvisioner ?? this.createK8sProvisioner();
  }

  private createK8sProvisioner(): KubernetesProvisioner | null {
    try {
      return new KubernetesProvisioner();
    } catch (error) {
      logger.warn(
        { error },
        'Kubernetes クラスターに接続できません。Serverless モードで動作します'
      );
      return null;
    }
  }

  async provisionTenant(tenant: Tenant): Promise<void> {
    logger.info(
      {
        tenantId: tenant.id,
        slug: tenant.slug,
        computeType: tenant.computeType,
      },
      'テナントのプロビジョニングを開始します'
    );

    try {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { provisioningStatus: 'IN_PROGRESS' },
      });

      logger.info('Auth0 Organization をプロビジョニング中...');
      const auth0Result = await this.auth0Provisioner.createTenantOrganization(
        tenant.slug,
        tenant.name,
        tenant.tier
      );

      logger.info(
        { organizationId: auth0Result.organizationId },
        'Auth0 Organization を作成しました'
      );

      if (tenant.computeType === 'KUBERNETES' && this.k8sProvisioner) {
        logger.info('Kubernetes リソースをプロビジョニング中...');
        const namespace = await this.k8sProvisioner.createNamespace(
          tenant.slug
        );
        await this.k8sProvisioner.deployParticipantApp(tenant.slug, namespace);
        logger.info({ namespace }, 'Kubernetes リソースを作成しました');
      } else {
        logger.info(
          'Serverless モード: Kubernetes リソースのプロビジョニングをスキップします'
        );
      }

      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          provisioningStatus: 'COMPLETED',
          status: 'ACTIVE',
        },
      });

      logger.info(
        { tenantId: tenant.id },
        'プロビジョニングが正常に完了しました'
      );
    } catch (error) {
      logger.error(
        { error, tenantId: tenant.id },
        'プロビジョニングに失敗しました'
      );

      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { provisioningStatus: 'FAILED' },
      });

      throw error;
    }
  }
}
