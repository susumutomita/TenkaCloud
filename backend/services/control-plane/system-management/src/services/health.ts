import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('health-service');

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  checks: {
    database: ComponentHealth;
    memory: ComponentHealth;
  };
}

export interface ComponentHealth {
  status: 'healthy' | 'unhealthy';
  latency?: number;
  message?: string;
}

export interface ReadinessResult {
  ready: boolean;
  timestamp: string;
  checks: {
    database: boolean;
  };
}

export class HealthService {
  private readonly version: string;

  constructor() {
    this.version = process.env.SERVICE_VERSION ?? '0.1.0';
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const timestamp = new Date().toISOString();
    const databaseHealth = await this.checkDatabase();
    const memoryHealth = this.checkMemory();

    const allHealthy =
      databaseHealth.status === 'healthy' && memoryHealth.status === 'healthy';
    const anyUnhealthy =
      databaseHealth.status === 'unhealthy' ||
      memoryHealth.status === 'unhealthy';

    let status: 'healthy' | 'unhealthy' | 'degraded';
    if (allHealthy) {
      status = 'healthy';
    } else if (anyUnhealthy) {
      status = 'unhealthy';
      /* v8 ignore start */
    } else {
      status = 'degraded';
    }
    /* v8 ignore stop */

    return {
      status,
      timestamp,
      version: this.version,
      checks: {
        database: databaseHealth,
        memory: memoryHealth,
      },
    };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const timestamp = new Date().toISOString();
    const databaseReady = await this.isDatabaseReady();

    return {
      ready: databaseReady,
      timestamp,
      checks: {
        database: databaseReady,
      },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const startTime = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      const latency = Date.now() - startTime;
      return {
        status: 'healthy',
        latency,
      };
    } catch (error) {
      logger.error({ error }, 'データベースヘルスチェック失敗');
      return {
        status: 'unhealthy',
        message: 'データベース接続エラー',
      };
    }
  }

  private async isDatabaseReady(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private checkMemory(): ComponentHealth {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const usagePercent = (used.heapUsed / used.heapTotal) * 100;

    // メモリ使用率が90%を超えたら unhealthy
    if (usagePercent > 90) {
      return {
        status: 'unhealthy',
        message: `メモリ使用率が高い: ${heapUsedMB}MB / ${heapTotalMB}MB (${usagePercent.toFixed(1)}%)`,
      };
    }

    return {
      status: 'healthy',
      message: `${heapUsedMB}MB / ${heapTotalMB}MB`,
    };
  }
}
