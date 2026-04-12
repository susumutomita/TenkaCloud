#!/usr/bin/env bun

import {
  createOnePassReport,
  formatOnePassReportAsMarkdown,
  type OnePassStepResult,
  type OnePassTarget,
} from '../packages/shared/src/quality';

interface CliOptions {
  target: OnePassTarget;
  allowBlocked: boolean;
  pollIntervalMs: number;
  provisionTimeoutMs: number;
}

interface HarnessConfig {
  target: OnePassTarget;
  controlPlaneApiBaseUrl: string;
  applicationAdminApiBaseUrl: string;
  applicationParticipantApiBaseUrl: string;
  applicationPlaneUrl: string;
  gamedayApiBaseUrl: string;
  controlPlaneToken?: string;
  applicationAdminToken?: string;
  applicationParticipantToken?: string;
}

interface DevIdentityHeaders {
  'X-TenkaCloud-Dev-User-Id'?: string;
  'X-TenkaCloud-Dev-Tenant-Id'?: string;
  'X-TenkaCloud-Dev-Roles'?: string;
}

interface TenantProvisioningStatus {
  tenantId: string;
  provisioningStatus: string;
  applicationDeploymentStatus?: string;
  provisionedResources?: unknown;
  provisioningError?: string | null;
  provisionedAt?: string | null;
  provisioningEnabled: boolean;
}

interface TenantResponse {
  id: string;
  slug: string;
  computeType: string;
}

interface EventResponse {
  id: string;
  name: string;
}

interface ProblemResponse {
  id: string;
  title: string;
}

interface DeployProblemResponse {
  stackName?: string;
  outputs?: Record<string, string>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    target: 'local',
    allowBlocked: false,
    pollIntervalMs: 1000,
    provisionTimeoutMs: 20000,
  };

  for (const arg of argv) {
    if (arg === '--allow-blocked') {
      options.allowBlocked = true;
      continue;
    }

    if (arg.startsWith('--target=')) {
      const target = arg.slice('--target='.length);
      if (target === 'local' || target === 'aws') {
        options.target = target;
      }
      continue;
    }

    if (arg.startsWith('--poll-interval-ms=')) {
      const value = Number.parseInt(arg.slice('--poll-interval-ms='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        options.pollIntervalMs = value;
      }
      continue;
    }

    if (arg.startsWith('--provision-timeout-ms=')) {
      const value = Number.parseInt(
        arg.slice('--provision-timeout-ms='.length),
        10,
      );
      if (Number.isFinite(value) && value > 0) {
        options.provisionTimeoutMs = value;
      }
    }
  }

  return options;
}

function getConfig(target: OnePassTarget): HarnessConfig {
  if (target === 'local') {
    return {
      target,
      controlPlaneApiBaseUrl:
        process.env.ONE_PASS_CONTROL_PLANE_API_BASE_URL ??
        'http://localhost:13004/api',
      applicationAdminApiBaseUrl:
        process.env.ONE_PASS_APPLICATION_ADMIN_API_BASE_URL ??
        'http://localhost:3100/api',
      applicationParticipantApiBaseUrl:
        process.env.ONE_PASS_APPLICATION_PARTICIPANT_API_BASE_URL ??
        'http://localhost:3100/api',
      applicationPlaneUrl:
        process.env.ONE_PASS_APPLICATION_PLANE_URL ?? 'http://localhost:13001',
      gamedayApiBaseUrl:
        process.env.ONE_PASS_GAMEDAY_API_BASE_URL ?? 'http://localhost:3020',
      controlPlaneToken:
        process.env.ONE_PASS_CONTROL_PLANE_TOKEN ?? 'mock-access-token',
      applicationAdminToken:
        process.env.ONE_PASS_APPLICATION_ADMIN_TOKEN ?? 'mock-access-token',
      applicationParticipantToken:
        process.env.ONE_PASS_APPLICATION_PARTICIPANT_TOKEN ??
        'mock-access-token',
    };
  }

  return {
    target,
    controlPlaneApiBaseUrl: requireEnv('ONE_PASS_CONTROL_PLANE_API_BASE_URL'),
    applicationAdminApiBaseUrl: requireEnv(
      'ONE_PASS_APPLICATION_ADMIN_API_BASE_URL',
    ),
    applicationParticipantApiBaseUrl: requireEnv(
      'ONE_PASS_APPLICATION_PARTICIPANT_API_BASE_URL',
    ),
    applicationPlaneUrl: requireEnv('ONE_PASS_APPLICATION_PLANE_URL'),
    gamedayApiBaseUrl: requireEnv('ONE_PASS_GAMEDAY_API_BASE_URL'),
    controlPlaneToken: requireEnv('ONE_PASS_CONTROL_PLANE_TOKEN'),
    applicationAdminToken: requireEnv('ONE_PASS_APPLICATION_ADMIN_TOKEN'),
    applicationParticipantToken: requireEnv('ONE_PASS_APPLICATION_PARTICIPANT_TOKEN'),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildHeaders(
  token?: string,
  contentType = true,
  devHeaders?: DevIdentityHeaders,
): HeadersInit {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...devHeaders,
  };
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  token?: string,
  devHeaders?: DevIdentityHeaders,
): Promise<T> {
  const headers = {
    ...buildHeaders(
      token,
      init.body !== undefined || init.method === 'POST',
      devHeaders,
    ),
    ...init.headers,
  };

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const body = text.length > 0 ? safeParseJson(text) : null;

  if (!response.ok) {
    const errorMessage =
      extractErrorMessage(body) || `${response.status} ${response.statusText}`;
    throw new HttpError(errorMessage, response.status, body);
  }

  return body as T;
}

async function requestStatus(
  url: string,
  init: RequestInit = {},
  token?: string,
  devHeaders?: DevIdentityHeaders,
): Promise<Response> {
  const headers = {
    ...buildHeaders(token, false, devHeaders),
    ...init.headers,
  };

  return fetch(url, { ...init, headers });
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body : null;
  }

  const error = 'error' in body ? body.error : null;
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    return typeof message === 'string' ? message : null;
  }

  const message = 'message' in body ? body.message : null;
  return typeof message === 'string' ? message : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createStep(
  id: string,
  label: string,
  status: OnePassStepResult['status'],
  detail: string,
  hint?: string,
): OnePassStepResult {
  return { id, label, status, detail, hint };
}

function timestampSuffix(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function createDevHeaders(input: {
  userId: string;
  tenantId: string;
  roles: string[];
}): DevIdentityHeaders {
  return {
    'X-TenkaCloud-Dev-User-Id': input.userId,
    'X-TenkaCloud-Dev-Tenant-Id': input.tenantId,
    'X-TenkaCloud-Dev-Roles': input.roles.join(','),
  };
}

function gamedayAdminUrl(config: HarnessConfig, path: string): string {
  return `${config.gamedayApiBaseUrl}/api/gameday/admin${path}`;
}

function gamedayParticipantUrl(config: HarnessConfig, path: string): string {
  return `${config.gamedayApiBaseUrl}/api/gameday${path}`;
}

async function createEventForOnePass(
  config: HarnessConfig,
  runId: string,
  adminHeaders: DevIdentityHeaders,
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

async function createSoloMembership(
  config: HarnessConfig,
  eventId: string,
  participantHeaders: DevIdentityHeaders,
): Promise<{ teamId: string }> {
  await requestJson(
    gamedayParticipantUrl(config, '/teams/solo'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const membershipResponse = await requestJson<
    | { teamId: string }
    | {
        membership?: {
          teamId?: string;
        } | null;
      }
  >(
    gamedayParticipantUrl(
      config,
      `/teams/my-membership?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const teamId =
    'teamId' in membershipResponse
      ? membershipResponse.teamId
      : membershipResponse.membership?.teamId;

  if (!teamId) {
    throw new Error('Participant team membership did not return a teamId');
  }

  return { teamId };
}

async function exerciseParticipantFlow(
  config: HarnessConfig,
  eventId: string,
  teamId: string,
  participantHeaders: DevIdentityHeaders,
  adminHeaders: DevIdentityHeaders,
): Promise<void> {
  const attacks = await requestJson<{ attacks: Array<{ id: string; slug: string }> }>(
    gamedayParticipantUrl(
      config,
      `/attacks/catalog?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );
  const attack = attacks.attacks[0];
  if (!attack) {
    throw new Error('Attack catalog is empty');
  }

  await requestJson(
    gamedayParticipantUrl(config, '/attacks/purchase'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId, attackId: attack.id }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/attacks/execute'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        attackId: attack.id,
        targetTeamId: 'one-pass-target',
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayAdminUrl(config, '/fault-injection/execute'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        attackSlug: attack.slug,
      }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  const defense = await requestJson<{ attacks: Array<{ attackId: string }> }>(
    gamedayParticipantUrl(
      config,
      `/defense/active?eventId=${encodeURIComponent(eventId)}&teamId=${encodeURIComponent(teamId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  if (defense.attacks.length === 0) {
    throw new Error('Defense active list is empty after fault injection');
  }

  await requestJson(
    gamedayParticipantUrl(config, '/defense/hint'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId, attackId: attack.id }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/defense/report-fix'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        vulnerabilitySlug: attack.slug,
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/voting/vote'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        votedForTeamId: 'one-pass-target',
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const voting = await requestJson<{ results: unknown[] }>(
    gamedayParticipantUrl(
      config,
      `/voting/results?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  if (voting.results.length === 0) {
    throw new Error('Voting results are empty after submitting a vote');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getConfig(options.target);
  const startedAt = new Date().toISOString();
  const steps: OnePassStepResult[] = [];
  const runId = timestampSuffix();
  const devTenantId = `one-pass-${runId.toLowerCase()}`;
  const adminHeaders = createDevHeaders({
    userId: `tenant-admin-${runId.toLowerCase()}`,
    tenantId: devTenantId,
    roles: ['tenant-admin', 'organizer'],
  });
  const participantHeaders = createDevHeaders({
    userId: `participant-${runId.toLowerCase()}`,
    tenantId: devTenantId,
    roles: ['participant', 'competitor'],
  });

  let tenant: TenantResponse | null = null;
  let provisioningStatus: TenantProvisioningStatus | null = null;
  let event: EventResponse | null = null;
  let problem: ProblemResponse | null = null;

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

  try {
    tenant = await requestJson<TenantResponse>(
      `${config.controlPlaneApiBaseUrl}/tenants`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: `One Pass Tenant ${runId}`,
          slug: `one-pass-${runId.toLowerCase()}`,
          adminEmail: `one-pass-${runId.toLowerCase()}@example.com`,
          tier: 'FREE',
          region: 'ap-northeast-1',
          isolationModel: 'POOL',
          computeType: 'SERVERLESS',
        }),
      },
      config.controlPlaneToken,
    );

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

  if (tenant) {
    try {
      await requestJson<{ success: boolean; provisioningStatus: string }>(
        `${config.controlPlaneApiBaseUrl}/tenants/${tenant.id}/provision`,
        { method: 'POST' },
        config.controlPlaneToken,
      );

      const deadline = Date.now() + options.provisionTimeoutMs;
      while (Date.now() < deadline) {
        provisioningStatus = await requestJson<TenantProvisioningStatus>(
          `${config.controlPlaneApiBaseUrl}/tenants/${tenant.id}/provision`,
          { method: 'GET' },
          config.controlPlaneToken,
        );

        if (
          provisioningStatus.provisioningStatus === 'COMPLETED' ||
          provisioningStatus.provisioningStatus === 'FAILED'
        ) {
          break;
        }

        await wait(options.pollIntervalMs);
      }

      provisioningStatus ??= await requestJson<TenantProvisioningStatus>(
        `${config.controlPlaneApiBaseUrl}/tenants/${tenant.id}/provision`,
        { method: 'GET' },
        config.controlPlaneToken,
      );

      if (!provisioningStatus.provisioningEnabled) {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'blocked',
            'PROVISIONING_ENABLED=false のため TenantOnboarding が publish されません。',
            'make start-one-pass-local で起動してください。',
          ),
        );
      } else if (provisioningStatus.provisioningStatus === 'FAILED') {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'failed',
            provisioningStatus.provisioningError ||
              'Provisioning status became FAILED.',
          ),
        );
      } else if (provisioningStatus.provisioningStatus !== 'COMPLETED') {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'blocked',
            `timeout waiting for completion: provisioningStatus=${provisioningStatus.provisioningStatus}`,
            'EventBridge / Lambda wiring を確認してください。',
          ),
        );
      } else {
        steps.push(
          createStep(
            '05',
            'tenant provisioning',
            'passed',
            `provisioningStatus=${provisioningStatus.provisioningStatus} applicationDeploymentStatus=${provisioningStatus.applicationDeploymentStatus ?? 'NOT_DEPLOYED'}`,
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
      provisioningStatus?.applicationDeploymentStatus ?? 'NOT_DEPLOYED';

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

  const adminAccess = await probeAdminAccess(config, adminHeaders);
  steps.push(adminAccess);

  if (adminAccess.status === 'passed') {
    try {
      event = await createEventForOnePass(config, runId, adminHeaders);

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
      problem = await requestJson<ProblemResponse>(
        `${config.applicationAdminApiBaseUrl}/admin/problems`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: `One Pass Security Battle Royale ${runId}`,
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
        adminHeaders,
      );

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

  if (event && problem) {
    try {
      await requestJson(
        `${config.applicationAdminApiBaseUrl}/admin/events/${event.id}/problems`,
        {
          method: 'POST',
          body: JSON.stringify({ problemId: problem.id }),
        },
        config.applicationAdminToken,
        adminHeaders,
      );

      steps.push(
        createStep(
          '10',
          'event problem attach',
          'passed',
          `eventId=${event.id} problemId=${problem.id}`,
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
        problem.id,
        `one-pass-${runId.toLowerCase()}`,
        adminHeaders,
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
        `${config.applicationAdminApiBaseUrl}/admin/events/${event.id}/competitor-accounts`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: `Local Team ${runId}`,
            provider: 'local',
            accountId: `local-${runId.toLowerCase()}`,
            region: 'local',
          }),
        },
        config.applicationAdminToken,
        adminHeaders,
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
      await initializeGameDayRuntime(config, event.id, adminHeaders);

      steps.push(
        createStep(
          '13',
          'gameday runtime init',
          'passed',
          `eventId=${event.id} game initialized, attacks seeded, target team registered`,
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

  if (event) {
    try {
      const registerResult = await requestJson<{ success: boolean; message: string }>(
        `${config.applicationParticipantApiBaseUrl}/participant/events/${event.id}/register`,
        { method: 'POST' },
        config.applicationParticipantToken,
        participantHeaders,
      );

      steps.push(
        createStep(
          '14',
          'participant register',
          registerResult.success ? 'passed' : 'failed',
          registerResult.message,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '14',
          'participant register',
          'failed',
          formatError(error),
        ),
      );
    }

    try {
      const myEvents = await requestJson<{ events: Array<{ id: string }> }>(
        `${config.applicationParticipantApiBaseUrl}/participant/events/me`,
        { method: 'GET' },
        config.applicationParticipantToken,
        participantHeaders,
      );
      const found = myEvents.events.some((candidate) => candidate.id === event?.id);

      steps.push(
        createStep(
          '15',
          'participant my events',
          found ? 'passed' : 'failed',
          found
            ? `registered event ${event.id} is present in /participant/events/me`
            : `registered event ${event.id} is missing from /participant/events/me`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '15',
          'participant my events',
          'failed',
          formatError(error),
        ),
      );
    }

    let membership: { teamId: string } | null = null;
    try {
      membership = await createSoloMembership(config, event.id, participantHeaders);
      steps.push(
        createStep(
          '16',
          'participant team membership',
          'passed',
          `teamId=${membership.teamId}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '16',
          'participant team membership',
          'failed',
          formatError(error),
        ),
      );
    }

    if (membership) {
      try {
      await exerciseParticipantFlow(
        config,
        event.id,
        membership.teamId,
        participantHeaders,
        adminHeaders,
      );
      steps.push(
        createStep(
          '17',
          'attack / defense / vote',
          'passed',
          `eventId=${event.id} teamId=${membership.teamId}`,
        ),
      );
      } catch (error) {
        steps.push(
          createStep(
            '17',
            'attack / defense / vote',
            'failed',
            formatError(error),
          ),
        );
      }
    } else {
      steps.push(
        createStep(
          '17',
          'attack / defense / vote',
          'blocked',
          'team membership の確立に失敗したため実行できません。',
        ),
      );
    }

    try {
      await requestJson<{ url: string }>(
        `${config.applicationPlaneUrl}/api/participant/events/${event.id}/aws-console`,
        { method: 'GET' },
        undefined,
        participantHeaders,
      );

      steps.push(
        createStep(
          '18',
          'participant aws console',
          'passed',
          'aws console url generated',
        ),
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 404 &&
        /not configured/i.test(error.message)
      ) {
        steps.push(
          createStep(
            '18',
            'participant aws console',
            options.target === 'local' ? 'passed' : 'blocked',
            options.target === 'local'
              ? 'local mode は aws-console を fail-closed で確認しました。'
              : 'AWS Console role federation が event に接続されていません。',
            options.target === 'local'
              ? 'AWS_PARTICIPANT_ROLE_ARN を設定した場合は `--target=aws` の受け入れ条件で成功確認してください。'
              : 'deploy outputs か event settings から participant console role を解決する必要があります。',
          ),
        );
      } else {
        steps.push(
          createStep(
            '18',
            'participant aws console',
            'failed',
            formatError(error),
          ),
        );
      }
    }
  } else {
    steps.push(
      createStep(
        '14',
        'participant register',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '15',
        'participant my events',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '16',
        'participant team membership',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '17',
        'attack / defense / vote',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '18',
        'participant aws console',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
  }

  const report = createOnePassReport({
    target: options.target,
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
  });

  console.log(formatOnePassReportAsMarkdown(report));

  if (
    report.overallStatus === 'failed' ||
    (!options.allowBlocked && report.overallStatus === 'blocked')
  ) {
    process.exitCode = 2;
  }
}

async function probeAdminAccess(
  config: HarnessConfig,
  adminHeaders: DevIdentityHeaders,
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

function formatError(error: unknown): string {
  if (error instanceof HttpError) {
    const detail =
      typeof error.body === 'string'
        ? error.body
        : extractErrorMessage(error.body) || JSON.stringify(error.body);
    return `HTTP ${error.status}: ${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

main().catch((error: unknown) => {
  console.error('[one-pass] failed:', formatError(error));
  process.exitCode = 1;
});
