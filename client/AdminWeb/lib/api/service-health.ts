import { loadConfig } from '@/lib/runtime-config';
import { adminFetch, type Microservice } from './admin-api-client';

export type ServiceConnectionState = 'connected' | 'unreachable';

export interface ServiceConnection {
  id: string;
  name: string;
  status: ServiceConnectionState;
  checkedUrl: string;
  detail?: string;
}

interface ServiceHealthTarget {
  id: Microservice;
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

async function inspect(
  url: string,
  target: ServiceHealthTarget,
): Promise<ServiceConnection | { detail: string }> {
  try {
    const response = await fetch(url, getFetchOptions());
    if (!response.ok) {
      return { detail: `HTTP ${response.status}` };
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
      return { detail: reportedStatus ?? 'unhealthy' };
    }

    return {
      id: target.id,
      name: target.name,
      status: 'connected',
      checkedUrl: url,
      detail: reportedService || reportedStatus,
    };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function checkLocal(
  target: ServiceHealthTarget,
): Promise<ServiceConnection> {
  const configuredUrl = process.env[target.envKey];
  const candidates = configuredUrl
    ? [configuredUrl]
    : preferLocalUrls()
      ? [target.localUrl, target.dockerUrl]
      : [target.dockerUrl, target.localUrl];

  let lastDetail = 'ヘルスチェックに失敗しました';
  for (const url of candidates) {
    const result = await inspect(url, target);
    if ('status' in result) return result;
    lastDetail = result.detail;
  }

  return {
    id: target.id,
    name: target.name,
    status: 'unreachable',
    checkedUrl: candidates[0],
    detail: lastDetail,
  };
}

async function checkCloud(
  target: ServiceHealthTarget,
): Promise<ServiceConnection> {
  // cloud では admin API gateway 経由 (`/<service>/health`、auth 不要)。
  try {
    const fetchOpts = getFetchOptions();
    const res = await adminFetch(target.id, '/health', {
      cache: fetchOpts.cache,
      signal: fetchOpts.signal,
      skipAuth: true,
    });

    if (!res.ok) {
      return {
        id: target.id,
        name: target.name,
        status: 'unreachable',
        checkedUrl: `(admin-api)/${target.id}/health`,
        detail: `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json().catch(() => null)) as {
      status?: string;
      service?: string;
    } | null;

    return {
      id: target.id,
      name: target.name,
      status: 'connected',
      checkedUrl: `(admin-api)/${target.id}/health`,
      detail: payload?.service || payload?.status,
    };
  } catch (error) {
    return {
      id: target.id,
      name: target.name,
      status: 'unreachable',
      checkedUrl: `(admin-api)/${target.id}/health`,
      detail: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function checkServiceConnection(
  target: ServiceHealthTarget,
): Promise<ServiceConnection> {
  // 環境判定: cloud (runtime-config に adminApiUrl 有り) なら admin API 経由でチェック。
  // dev / Docker は localhost を使う従来のロジック。
  let useCloud = false;
  try {
    const config = await loadConfig();
    useCloud = Boolean(config.adminApiUrl);
  } catch {
    // runtime-config 読めない (= dev で env も未設定) → local fallback
  }

  return useCloud ? checkCloud(target) : checkLocal(target);
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
