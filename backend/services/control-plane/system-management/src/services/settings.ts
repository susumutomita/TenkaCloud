import type { Prisma, SystemSetting } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { AuditService } from './audit';

const logger = createLogger('settings-service');

export interface CreateSettingInput {
  key: string;
  value: Prisma.InputJsonValue;
  category: string;
  updatedBy: string;
}

export interface UpdateSettingInput {
  value: Prisma.InputJsonValue;
  updatedBy: string;
}

export interface DeleteSettingInput {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ListSettingsInput {
  category?: string;
  limit?: number;
  offset?: number;
}

export interface ListSettingsResult {
  settings: SystemSetting[];
  total: number;
}

export class SettingsService {
  private readonly auditService: AuditService;

  constructor(auditService?: AuditService) {
    this.auditService = auditService ?? new AuditService();
  }

  async createSetting(input: CreateSettingInput): Promise<SystemSetting> {
    logger.info(
      { key: input.key, category: input.category },
      '設定を作成します'
    );

    const setting = await prisma.systemSetting.create({
      data: {
        key: input.key,
        value: input.value,
        category: input.category,
        updatedBy: input.updatedBy,
      },
    });

    logger.info({ settingId: setting.id }, '設定を作成しました');

    return setting;
  }

  async getSettingByKey(key: string): Promise<SystemSetting | null> {
    return prisma.systemSetting.findUnique({
      where: { key },
    });
  }

  async updateSetting(
    key: string,
    input: UpdateSettingInput
  ): Promise<SystemSetting> {
    logger.info({ key }, '設定を更新します');

    const setting = await prisma.systemSetting.update({
      where: { key },
      data: {
        value: input.value,
        updatedBy: input.updatedBy,
      },
    });

    logger.info({ settingId: setting.id }, '設定を更新しました');

    return setting;
  }

  async deleteSetting(key: string, input: DeleteSettingInput): Promise<void> {
    logger.info({ key, userId: input.userId }, '設定を削除します');

    const existingSetting = await prisma.systemSetting.findUnique({
      where: { key },
    });

    await prisma.systemSetting.delete({
      where: { key },
    });

    // 監査ログを記録
    await this.auditService.createLog({
      userId: input.userId,
      action: 'DELETE',
      resourceType: 'SETTING',
      resourceId: existingSetting?.id,
      details: { key, category: existingSetting?.category },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    logger.info({ key }, '設定を削除しました');
  }

  async listSettings(input: ListSettingsInput): Promise<ListSettingsResult> {
    const where = {
      ...(input.category && { category: input.category }),
    };

    const [settings, total] = await Promise.all([
      prisma.systemSetting.findMany({
        where,
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
        orderBy: { key: 'asc' },
      }),
      prisma.systemSetting.count({ where }),
    ]);

    return { settings, total };
  }

  async getSettingsByCategory(category: string): Promise<SystemSetting[]> {
    return prisma.systemSetting.findMany({
      where: { category },
      orderBy: { key: 'asc' },
    });
  }
}
