import type { OnePassStepResult } from '../../../packages/shared/src/quality';
import type {
  HarnessConfig,
  CliOptions,
  OnePassState,
  TenantResponse,
  TenantProvisioningStatus,
} from '../config';
import { createStep, wait } from '../config';
import { requestJson, requestStatus, formatError } from '../http';

export async function runTenantSteps(
  config: HarnessConfig,
  options: CliOptions,
  state: OnePassState,
): Promise<OnePassStepResult[]> {
  const steps: OnePassStepResult[] = [];

  try {
    const tenant = await requestJson<TenantResponse>(
      `${config.controlPlaneApiBaseUrl}/tenants`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: `One Pass Tenant ${state.runId}`,
          slug: `one-pass-${state.runId.toLowerCase()}`,
          adminEmail: `one-pass-${state.runId.toLowerCase()}@example.com`,
          tier: 'FREE',
          region: 'ap-northeast-1',
          isolationModel: 'POOL',
          computeType: 'SERVERLESS',
        }),
      },
      config.controlPlaneToken,
    );

    state.tenant = tenant;

    steps.push(
      createStep(
        '04',
        'tenant create',
        'passed',
        `tenantId=${tenant.id} slug=${tenant.slug} computeType=${tenant.computeType}`,
      ),
    );
  } catch (error) {
    steps.push(createStep('04', 'tenant create', 'failed', formatError(error)));
  }

  if (state.tenant) {
    try {
      await requestJson<{ success: boolean; provisioningStatus: string }>(
        `${config.controlPlaneApiBaseUrl}/tenants/${state.tenant.id}/provision`,
        { method: 'POST' },
        config.controlPlaneToken,
      );

      const deadline = Date.now() + options.provisionTimeoutMs;
      while (Date.now() < deadline) {
        state.provisioningStatus = await requestJson<TenantProvisioningStatus>(
          `${config.controlPlaneApiBaseUrl}/tenants/${state.tenant.id}/provision`,
          { method: 'GET' },
          config.controlPlaneToken,
        );

        if (
          state.provisioningStatus.provisioningStatus === 'COMPLETED' ||
          state.provisioningStatus.provisioningStatus === 'FAILED'
        ) {
          break;
        }

        await wait(options.pollIntervalMs);
      }

      state.provisioningStatus ??= await requestJson<TenantProvisioningStatus>(
        `${config.controlPlaneApiBaseUrl}/tenants/${state.tenant.id}/provision`,
        { method: 'GET' },
        config.controlPlaneToken,
      );

      if (!state.provisioningStatus.provisioningEnabled) {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'blocked',
            'PROVISIONING_ENABLED=false のため TenantOnboarding が publish されません。',
            'make start-one-pass-local で起動してください。',
          ),
        );
      } else if (state.provisioningStatus.provisioningStatus === 'FAILED') {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'failed',
            state.provisioningStatus.provisioningError ||
              'Provisioning status became FAILED.',
          ),
        );
      } else if (state.provisioningStatus.provisioningStatus !== 'COMPLETED') {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'blocked',
            `timeout waiting for completion: provisioningStatus=${state.provisioningStatus.provisioningStatus}`,
            'EventBridge / Lambda wiring を確認してください。',
          ),
        );
      } else {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'passed',
            `provisioningStatus=${state.provisioningStatus.provisioningStatus} applicationDeploymentStatus=${state.provisioningStatus.applicationDeploymentStatus ?? 'NOT_DEPLOYED'}`,
          ),
        );
      }
    } catch (error) {
      steps.push(
        createStep('05', 'tenant provisioning', 'failed', formatError(error)),
      );
    }
  } else {
    steps.push(
      createStep(
        '05',
        'tenant provisioning',
        'blocked',
        'tenant create が失敗したため実行できません。',
      ),
    );
  }

  try {
    const appResponse = await requestStatus(
      `${config.applicationPlaneUrl}/`,
      { method: 'GET' },
    );
    const deploymentStatus =
      state.provisioningStatus?.applicationDeploymentStatus ?? 'NOT_DEPLOYED';

    if (options.target === 'local') {
      steps.push(
        createStep(
          '06',
          'tenant application plane runtime',
          appResponse.ok ? 'passed' : 'failed',
          `status=${appResponse.status} shared application plane is reachable (applicationDeploymentStatus=${deploymentStatus})`,
        ),
      );
    } else if (deploymentStatus === 'DEPLOYED') {
      steps.push(
        createStep(
          '06',
          'tenant application plane runtime',
          appResponse.ok ? 'passed' : 'failed',
          `status=${appResponse.status} applicationDeploymentStatus=${deploymentStatus}`,
        ),
      );
    } else {
      steps.push(
        createStep(
          '06',
          'tenant application plane runtime',
          'blocked',
          `HTTP ${appResponse.status} で共有 Application Plane には到達できますが tenant runtime descriptor が未配備です。applicationDeploymentStatus=${deploymentStatus}`,
          'tenant ごとの endpoint / runtimeVersion / deployment descriptor を provisioning 完了に接続してください。',
        ),
      );
    }
  } catch (error) {
    steps.push(
      createStep(
        '06',
        'tenant application plane runtime',
        'failed',
        formatError(error),
      ),
    );
  }

  return steps;
}
