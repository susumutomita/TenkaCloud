import {
  auditLogRepository,
  systemSettingRepository,
  serviceHealthRepository,
} from '../lib/dynamodb';
import { createLogger } from '../lib/logger';

const logger = createLogger('metrics-service');

export interface SystemMetrics {
  timestamp: string;
  system: {
    uptime: number;
    memory: MemoryMetrics;
    cpu: CpuMetrics;
  };
  database: DatabaseMetrics;
  application: ApplicationMetrics;
}

export interface MemoryMetrics {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  usagePercent: number;
}

export interface CpuMetrics {
  user: number;
  system: number;
}

export interface DatabaseMetrics {
  connectionStatus: 'connected' | 'disconnected';
  latencyMs: number;
}

export interface ApplicationMetrics {
  auditLogsCount: number;
  settingsCount: number;
}

export class MetricsService {
  private startTime: number;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;

  constructor() {
    this.startTime = Date.now();
  }

  async collectMetrics(): Promise<SystemMetrics> {
    logger.debug('メトリクスを収集します');

    const [databaseMetrics, applicationMetrics] = await Promise.all([
      this.collectDatabaseMetrics(),
      this.collectApplicationMetrics(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      system: {
        uptime: this.getUptime(),
        memory: this.collectMemoryMetrics(),
        cpu: this.collectCpuMetrics(),
      },
      database: databaseMetrics,
      application: applicationMetrics,
    };
  }

  private getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  private collectMemoryMetrics(): MemoryMetrics {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      usagePercent: (usage.heapUsed / usage.heapTotal) * 100,
    };
  }

  private collectCpuMetrics(): CpuMetrics {
    const currentUsage = process.cpuUsage(this.lastCpuUsage ?? undefined);
    this.lastCpuUsage = process.cpuUsage();

    return {
      user: currentUsage.user / 1000, // マイクロ秒からミリ秒へ
      system: currentUsage.system / 1000,
    };
  }

  private async collectDatabaseMetrics(): Promise<DatabaseMetrics> {
    const startTime = Date.now();
    try {
      // DynamoDB の疎通確認として自サービスのヘルスを取得/更新
      await serviceHealthRepository.upsert({
        serviceName: 'system-management',
        status: 'active',
        details: { metricsCheck: new Date().toISOString() },
      });
      return {
        connectionStatus: 'connected',
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      logger.error({ error }, 'データベースメトリクス収集失敗');
      return {
        connectionStatus: 'disconnected',
        latencyMs: -1,
      };
    }
  }

  private async collectApplicationMetrics(): Promise<ApplicationMetrics> {
    // DynamoDB ではカウントが効率的でないため、概算値を取得
    const [auditResult, settings] = await Promise.all([
      auditLogRepository.listByTenant('', { limit: 1 }),
      systemSettingRepository.listAll(),
    ]);

    return {
      // 概算: 取得できた数（本格的な集計は別途実装が必要）
      auditLogsCount: auditResult.logs.length > 0 ? -1 : 0, // -1 = 集計不可
      settingsCount: settings.length,
    };
  }
}
