import type { OnePassStepResult } from '../../../packages/shared/src/quality';
import type {
  HarnessConfig,
  CliOptions,
  OnePassState,
  EventResponse,
  ProblemResponse,
} from '../config';
import { createStep } from '../config';
import { HttpError, requestJson, formatError } from '../http';

async function probeAdminAccess(
  config: HarnessConfig,
  adminHeaders: OnePassState['adminHeaders'],
): Promise<OnePassStepResult> {
  try {
    await requestJson(
      `${config.applicationAdminApiBaseUrl}/admin/events`,
      { method: 'GET' },
      config.applicationAdminToken,
      adminHeaders,
    );
    return createStep(
      '07',
      'application admin access',
      'passed',
      'admin routes are reachable with explicit dev identity headers.',
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      return createStep(
        '07',
        'application admin access',
        'blocked',
        'Application Plane admin route returned 403 even with explicit dev admin identity headers.',
        'problem-service AUTH_SKIP の開発用ヘッダー上書きが有効か確認してください。',
      );
    }

    if (error instanceof HttpError && error.status === 401) {
      return createStep(
        '07',
        'application admin access',
        'blocked',
        'Application Plane admin route returned 401.',
        'AUTH_SKIP=1 と admin token 設定を確認してください。',
      );
    }

    return createStep(
      '07',
      'application admin access',
      'failed',
      formatError(error),
    );
  }
}

async function createEventForOnePass(
  config: HarnessConfig,
  runId: string,
  adminHeaders: OnePassState['adminHeaders'],
): Promise<EventResponse> {
  const event = await requestJson<EventResponse>(
    `${config.applicationAdminApiBaseUrl}/admin/events`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `One Pass Event ${runId}`,
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        type: 'gameday',
        participantType: 'team',
        maxParticipants: 8,
        minTeamSize: 1,
        maxTeamSize: 4,
        cloudProvider: 'local',
        regions: ['local'],
        scoringType: 'realtime',
        scoringIntervalMinutes: 5,
        leaderboardVisible: true,
      }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  await requestJson(
    `${config.applicationAdminApiBaseUrl}/admin/events/${event.id}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'scheduled' }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  await requestJson(
    `${config.applicationAdminApiBaseUrl}/admin/events/${event.id}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  return event;
}

export async function runAdminSteps(
  config: HarnessConfig,
  _options: CliOptions,
  state: OnePassState,
): Promise<OnePassStepResult[]> {
  const steps: OnePassStepResult[] = [];

  const adminAccess = await probeAdminAccess(config, state.adminHeaders);
  steps.push(adminAccess);

  if (adminAccess.status === 'passed') {
    try {
      const event = await createEventForOnePass(config, state.runId, state.adminHeaders);
      state.event = event;

      steps.push(
        createStep(
          '08',
          'event create',
          'passed',
          `eventId=${event.id} name=${event.name}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep('08', 'event create', 'failed', formatError(error)),
      );
    }

    try {
      const problem = await requestJson<ProblemResponse>(
        `${config.applicationAdminApiBaseUrl}/admin/problems`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: `One Pass Security Battle Royale ${state.runId}`,
            type: 'gameday',
            category: 'security',
            difficulty: 'easy',
            description: {
              overview: 'One-pass local deploy verification problem.',
              objectives: ['Deploy local stack', 'Attach to event'],
              hints: [],
              prerequisites: [],
              estimatedTime: 15,
            },
            metadata: {
              author: 'one-pass-harness',
              version: '1.0.0',
              tags: ['one-pass', 'local'],
            },
            deployment: {
              providers: ['local'],
              timeout: 5,
              templates: {
                local: {
                  type: 'docker-compose',
                  path: 'gameday/security-battle-royale/local/docker-compose.yaml',
                  parameters: {
                    DB_PASSWORD: 'one-pass-local-password',
                  },
                },
              },
              regions: {
                local: ['local'],
              },
            },
            scoring: {
              type: 'manual',
              path: 'manual://one-pass',
              timeoutMinutes: 5,
              criteria: [],
            },
          }),
        },
        config.applicationAdminToken,
        state.adminHeaders,
      );

      state.problem = problem;

      steps.push(
        createStep(
          '09',
          'problem create',
          'passed',
          `problemId=${problem.id} title=${problem.title}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep('09', 'problem create', 'failed', formatError(error)),
      );
    }
  } else {
    steps.push(
      createStep(
        '08',
        'event create',
        'blocked',
        'admin access が通っていないため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '09',
        'problem create',
        'blocked',
        'admin access が通っていないため実行できません。',
      ),
    );
  }

  return steps;
}
