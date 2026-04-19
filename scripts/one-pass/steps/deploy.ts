import type { OnePassStepResult } from '../../../packages/shared/src/quality';
import type {
  HarnessConfig,
  CliOptions,
  OnePassState,
  DeployProblemResponse,
  DevIdentityHeaders,
} from '../config';
import { createStep, gamedayAdminUrl } from '../config';
import { HttpError, requestJson, requestStatus, formatError } from '../http';

async function deployProblemLocally(
  config: HarnessConfig,
  problemId: string,
  stackName: string,
  adminHeaders: DevIdentityHeaders,
): Promise<DeployProblemResponse> {
  const deploy = await requestJson<DeployProblemResponse>(
    `${config.applicationAdminApiBaseUrl}/admin/problems/${problemId}/deploy`,
    {
      method: 'POST',
      body: JSON.stringify({
        provider: 'local',
        region: 'local',
        stackName,
      }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  const status = await requestJson<{
    status: string;
    outputs?: Record<string, string>;
  }>(
    `${config.applicationAdminApiBaseUrl}/admin/problems/${problemId}/deployments/${stackName}/status?provider=local&region=local`,
    { method: 'GET' },
    config.applicationAdminToken,
    adminHeaders,
  );

  if (status.status !== 'CREATE_COMPLETE') {
    throw new Error(
      `Local deployment did not reach CREATE_COMPLETE. status=${status.status}`,
    );
  }

  const serviceUrl =
    status.outputs?.ServiceUrl ||
    status.outputs?.FrontendUrl ||
    deploy.outputs?.ServiceUrl ||
    deploy.outputs?.FrontendUrl;

  if (serviceUrl) {
    const response = await requestStatus(serviceUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(
        `Deployed local runtime is not reachable: ${serviceUrl} (${response.status})`,
      );
    }
  }

  return {
    ...deploy,
    outputs: status.outputs ?? deploy.outputs,
  };
}

async function initializeGameDayRuntime(
  config: HarnessConfig,
  eventId: string,
  adminHeaders: DevIdentityHeaders,
): Promise<void> {
  try {
    await requestJson(
      gamedayAdminUrl(config, '/game/init'),
      {
        method: 'POST',
        body: JSON.stringify({ eventId, durationMinutes: 60 }),
      },
      config.applicationAdminToken,
      adminHeaders,
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) {
      throw error;
    }
  }

  await requestJson(
    gamedayAdminUrl(config, '/attacks/seed'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  await requestJson(
    gamedayAdminUrl(config, '/teams/register'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId: 'one-pass-target',
        teamName: 'One Pass Target',
      }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  await requestJson(
    gamedayAdminUrl(config, '/game/start'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId, durationMinutes: 60 }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );
}

export async function runDeploySteps(
  config: HarnessConfig,
  _options: CliOptions,
  state: OnePassState,
): Promise<OnePassStepResult[]> {
  const steps: OnePassStepResult[] = [];

  if (state.event && state.problem) {
    try {
      await requestJson(
        `${config.applicationAdminApiBaseUrl}/admin/events/${state.event.id}/problems`,
        {
          method: 'POST',
          body: JSON.stringify({ problemId: state.problem.id }),
        },
        config.applicationAdminToken,
        state.adminHeaders,
      );

      steps.push(
        createStep(
          '10',
          'event problem attach',
          'passed',
          `eventId=${state.event.id} problemId=${state.problem.id}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep('10', 'event problem attach', 'failed', formatError(error)),
      );
    }

    try {
      const deploy = await deployProblemLocally(
        config,
        state.problem.id,
        `one-pass-${state.runId.toLowerCase()}`,
        state.adminHeaders,
      );

      steps.push(
        createStep(
          '11',
          'local problem deploy',
          'passed',
          `stackName=${deploy.stackName ?? 'unknown'} outputs=${Object.keys(deploy.outputs ?? {}).join(',') || 'none'}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep('11', 'local problem deploy', 'failed', formatError(error)),
      );
    }

    try {
      const competitorAccount = await requestJson<{ id: string }>(
        `${config.applicationAdminApiBaseUrl}/admin/events/${state.event.id}/competitor-accounts`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: `Local Team ${state.runId}`,
            provider: 'local',
            accountId: `local-${state.runId.toLowerCase()}`,
            region: 'local',
          }),
        },
        config.applicationAdminToken,
        state.adminHeaders,
      );

      steps.push(
        createStep(
          '12',
          'competitor account register',
          'passed',
          `competitorAccountId=${competitorAccount.id}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '12',
          'competitor account register',
          'failed',
          formatError(error),
        ),
      );
    }

    try {
      await initializeGameDayRuntime(config, state.event.id, state.adminHeaders);

      steps.push(
        createStep(
          '13',
          'gameday runtime init',
          'passed',
          `eventId=${state.event.id} game initialized, attacks seeded, target team registered`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '13',
          'gameday runtime init',
          'failed',
          formatError(error),
        ),
      );
    }
  } else {
    steps.push(
      createStep(
        '10',
        'event problem attach',
        'blocked',
        'event または problem の作成に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '11',
        'local problem deploy',
        'blocked',
        'problem create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '12',
        'competitor account register',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '13',
        'gameday runtime init',
        'blocked',
        'event create または problem create に失敗したため実行できません。',
      ),
    );
  }

  return steps;
}
