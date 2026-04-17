import type { OnePassStepResult } from '../../../packages/shared/src/quality';
import type { HarnessConfig, CliOptions, OnePassState } from '../config';
import { createStep } from '../config';
import { requestJson, formatError } from '../http';

export async function runHealthSteps(
  config: HarnessConfig,
  _options: CliOptions,
  _state: OnePassState,
): Promise<OnePassStepResult[]> {
  const steps: OnePassStepResult[] = [];

  try {
    const tenantHealth = await requestJson<{ status: string; service?: string }>(
      `${config.controlPlaneApiBaseUrl.replace(/\/api$/, '')}/health`,
      { method: 'GET' },
      config.controlPlaneToken,
    );
    steps.push(
      createStep(
        '01',
        'tenant-management health',
        tenantHealth.status === 'ok' ? 'passed' : 'failed',
        `status=${tenantHealth.status}`,
      ),
    );
  } catch (error) {
    steps.push(
      createStep(
        '01',
        'tenant-management health',
        'failed',
        formatError(error),
      ),
    );
  }

  try {
    const problemHealth = await requestJson<{ status: string }>(
      `${config.applicationAdminApiBaseUrl.replace(/\/api$/, '')}/health`,
      { method: 'GET' },
      config.applicationAdminToken,
    );
    steps.push(
      createStep(
        '02',
        'problem-service health',
        problemHealth.status === 'ok' || problemHealth.status === 'healthy'
          ? 'passed'
          : 'failed',
        `status=${problemHealth.status}`,
      ),
    );
  } catch (error) {
    steps.push(
      createStep('02', 'problem-service health', 'failed', formatError(error)),
    );
  }

  try {
    const gamedayHealth = await requestJson<{ status: string }>(
      `${config.gamedayApiBaseUrl}/health`,
      { method: 'GET' },
      config.applicationParticipantToken,
    );
    steps.push(
      createStep(
        '03',
        'gameday-service health',
        gamedayHealth.status === 'ok' ? 'passed' : 'failed',
        `status=${gamedayHealth.status}`,
      ),
    );
  } catch (error) {
    steps.push(
      createStep('03', 'gameday-service health', 'failed', formatError(error)),
    );
  }

  return steps;
}
