import { TenantRepository, type Tenant } from '@tenkacloud/dynamodb';
import { createLogger } from '../lib/logger';
import { Auth0Provisioner } from './auth0';
import { KubernetesProvisioner } from './kubernetes';

const logger = createLogger('provisioning-manager');

export interface ProvisioningManagerDeps {
  auth0Provisioner?: Auth0Provisioner;
  k8sProvisioner?: KubernetesProvisioner;
  tenantRepository?: TenantRepository;
}

export class ProvisioningManager {
  private auth0Provisioner: Auth0Provisioner;
  private k8sProvisioner: KubernetesProvisioner | null;
  private tenantRepository: TenantRepository;

  constructor(deps?: ProvisioningManagerDeps) {
    this.auth0Provisioner = deps?.auth0Provisioner ?? new Auth0Provisioner();
    this.k8sProvisioner = deps?.k8sProvisioner ?? this.createK8sProvisioner();
    this.tenantRepository = deps?.tenantRepository ?? new TenantRepository();
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
      await this.tenantRepository.updateProvisioningStatus(
        tenant.id,
        'IN_PROGRESS'
      );

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

      await this.tenantRepository.update(tenant.id, {
        provisioningStatus: 'COMPLETED',
        status: 'ACTIVE',
        auth0OrgId: auth0Result.organizationId,
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

      await this.tenantRepository.updateProvisioningStatus(tenant.id, 'FAILED');

      throw error;
    }
  }
}
