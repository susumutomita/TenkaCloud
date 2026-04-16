export type ServiceConnectionState = 'connected' | 'unreachable';

export interface ServiceConnection {
  id: string;
  name: string;
  status: ServiceConnectionState;
  checkedUrl: string;
  detail?: string;
}

interface ServiceHealthTarget {
  id: string;
  name: string;
  envKey: string;
  localUrl: string;
  dockerUrl: string;
}

const SERVICE_HEALTH_TARGETS: ServiceHealthTarget[] = [
  {
    id: 'tenant-management',
    name: 'Tenant Management',
    envKey: 'TENANT_MANAGEMENT_HEALTH_URL',
    localUrl: 'http://localhost:13004/health',
    dockerUrl: 'http://tenant-management:13004/health',
  },
  {
    id: 'problem-service',
    name: 'Problem Service',
    envKey: 'PROBLEM_SERVICE_HEALTH_URL',
    localUrl: 'http://localhost:3100/health',
    dockerUrl: 'http://problem-service:3100/health',
  },
  {
    id: 'gameday-service',
    name: 'GameDay Service',
    envKey: 'GAMEDAY_SERVICE_HEALTH_URL',
    localUrl: 'http://localhost:3020/health',
    dockerUrl: 'http://gameday-service:3020/health',
  },
  {
    id: 'battle-service',
    name: 'Battle Service',
    envKey: 'BATTLE_SERVICE_HEALTH_URL',
    localUrl: 'http://localhost:3010/health',
    dockerUrl: 'http://battle-service:3010/health',
  },
  {
    id: 'scoring-service',
    name: 'Scoring Service',
    envKey: 'SCORING_SERVICE_HEALTH_URL',
    localUrl: 'http://localhost:3011/health',
    dockerUrl: 'http://scoring-service:3011/health',
  },
  {
    id: 'leaderboard-service',
    name: 'Leaderboard Service',
    envKey: 'LEADERBOARD_SERVICE_HEALTH_URL',
    localUrl: 'http://localhost:3012/health',
    dockerUrl: 'http://leaderboard-service:3012/health',
  },
];

function preferLocalUrls(): boolean {
  const tenantApiBaseUrl =
    process.env.TENANT_API_BASE_URL ||
    process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;

  return (
    tenantApiBaseUrl?.includes('localhost') === true ||
    tenantApiBaseUrl?.includes('127.0.0.1') === true
  );
}

function getFetchOptions(): RequestInit {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    };
  }

  return { cache: 'no-store' };
}

export function resolveServiceHealthUrls(): ServiceConnection[] {
  const localFirst = preferLocalUrls();

  return SERVICE_HEALTH_TARGETS.map((target) => {
    const configuredUrl = process.env[target.envKey];
    const checkedUrl =
      configuredUrl || (localFirst ? target.localUrl : target.dockerUrl);

    return {
      id: target.id,
      name: target.name,
      status: 'unreachable',
      checkedUrl,
    };
  });
}

function getCandidateUrls(target: ServiceHealthTarget): string[] {
  const configuredUrl = process.env[target.envKey];
  if (configuredUrl) {
    return [configuredUrl];
  }

  return preferLocalUrls()
    ? [target.localUrl, target.dockerUrl]
    : [target.dockerUrl, target.localUrl];
}

async function checkServiceConnection(
  target: ServiceHealthTarget,
): Promise<ServiceConnection> {
  let lastDetail = 'ヘルスチェックに失敗しました';

  for (const url of getCandidateUrls(target)) {
    try {
      const response = await fetch(url, getFetchOptions());
      if (!response.ok) {
        lastDetail = `HTTP ${response.status}`;
        continue;
      }

      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        service?: string;
      } | null;

      const reportedStatus = payload?.status;
      const reportedService = payload?.service;
      const isHealthy =
        reportedStatus === undefined ||
        reportedStatus === 'ok' ||
        reportedStatus === 'healthy';

      if (!isHealthy) {
        lastDetail = reportedStatus ?? 'unhealthy';
        continue;
      }

      return {
        id: target.id,
        name: target.name,
        status: 'connected',
        checkedUrl: url,
        detail: reportedService || reportedStatus,
      };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  return {
    id: target.id,
    name: target.name,
    status: 'unreachable',
    checkedUrl: getCandidateUrls(target)[0],
    detail: lastDetail,
  };
}

export async function fetchServiceConnections(): Promise<ServiceConnection[]> {
  return Promise.all(SERVICE_HEALTH_TARGETS.map(checkServiceConnection));
}

export function summarizeServiceConnections(
  services: ServiceConnection[],
): 'healthy' | 'degraded' | 'down' {
  const connectedCount = services.filter(
    (service) => service.status === 'connected',
  ).length;

  if (connectedCount === services.length && services.length > 0) {
    return 'healthy';
  }

  if (connectedCount === 0) {
    return 'down';
  }

  return 'degraded';
}
