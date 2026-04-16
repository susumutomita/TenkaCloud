import { tenantRepository } from '../lib/dynamodb';
import { createLogger } from '../lib/logger';
import { KeycloakProvisioner } from './keycloak';
import { KubernetesProvisioner } from './kubernetes';
import type { Tenant } from '@tenkacloud/dynamodb';

const logger = createLogger('provisioning-manager');

export class ProvisioningManager {
  private keycloakProvisioner: KeycloakProvisioner;
  private k8sProvisioner: KubernetesProvisioner;

  constructor() {
    this.keycloakProvisioner = new KeycloakProvisioner();
    this.k8sProvisioner = new KubernetesProvisioner();
  }

  async provisionTenant(tenant: Tenant) {
    logger.info(
      { tenantId: tenant.id, slug: tenant.slug },
      'Starting provisioning for tenant'
    );

    try {
      // Update status to IN_PROGRESS
      await tenantRepository.updateProvisioningStatus(tenant.id, 'IN_PROGRESS');

      // 1. Create Keycloak Realm
      logger.info('Provisioning Keycloak Realm...');
      await this.keycloakProvisioner.createRealm(tenant.slug, tenant.name);

      // 2. Create Kubernetes Namespace & Resources (if ComputeType is KUBERNETES or even for SERVERLESS if we use Knative)
      // For now, we assume we always create a namespace for isolation
      logger.info('Provisioning Kubernetes resources...');
      const namespace = await this.k8sProvisioner.createNamespace(tenant.slug);

      // Deploy Participant App (Base)
      await this.k8sProvisioner.deployParticipantApp(tenant.slug, namespace);

      // 3. Update status to COMPLETED
      await tenantRepository.update(tenant.id, {
        provisioningStatus: 'COMPLETED',
        status: 'ACTIVE',
      });

      logger.info(
        { tenantId: tenant.id },
        'Provisioning completed successfully'
      );
    } catch (error) {
      logger.error({ error, tenantId: tenant.id }, 'Provisioning failed');

      // Update status to FAILED
      await tenantRepository.updateProvisioningStatus(tenant.id, 'FAILED');
    }
  }
}
