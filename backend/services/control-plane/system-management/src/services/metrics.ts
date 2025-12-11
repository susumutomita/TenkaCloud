import { prisma } from '../lib/prisma';
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
      await prisma.$queryRaw`SELECT 1`;
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
    const [auditLogsCount, settingsCount] = await Promise.all([
      prisma.auditLog.count(),
      prisma.systemSetting.count(),
    ]);

    return {
      auditLogsCount,
      settingsCount,
    };
  }
}
