import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { KeycloakProvisioner } from './keycloak';
import { KubernetesProvisioner } from './kubernetes';
import type { Tenant } from '@prisma/client';

const logger = createLogger('provisioning-manager');

export interface ProvisioningManagerDeps {
  keycloakProvisioner?: KeycloakProvisioner;
  k8sProvisioner?: KubernetesProvisioner;
}

export class ProvisioningManager {
  private keycloakProvisioner: KeycloakProvisioner;
  private k8sProvisioner: KubernetesProvisioner;

  constructor(deps?: ProvisioningManagerDeps) {
    this.keycloakProvisioner =
      deps?.keycloakProvisioner ?? new KeycloakProvisioner();
    this.k8sProvisioner = deps?.k8sProvisioner ?? new KubernetesProvisioner();
  }

  async provisionTenant(tenant: Tenant): Promise<void> {
    logger.info(
      { tenantId: tenant.id, slug: tenant.slug },
      'テナントのプロビジョニングを開始します'
    );

    try {
      // Update status to IN_PROGRESS
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { provisioningStatus: 'IN_PROGRESS' },
      });

      // 1. Create Keycloak Realm
      logger.info('Keycloak Realmをプロビジョニング中...');
      await this.keycloakProvisioner.createRealm(tenant.slug, tenant.name);

      // 2. Create Kubernetes Namespace & Resources
      logger.info('Kubernetesリソースをプロビジョニング中...');
      const namespace = await this.k8sProvisioner.createNamespace(tenant.slug);

      // 3. Deploy Participant App
      await this.k8sProvisioner.deployParticipantApp(tenant.slug, namespace);

      // 4. Update status to COMPLETED
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

      // Update status to FAILED
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { provisioningStatus: 'FAILED' },
      });

      throw error;
    }
  }
}
