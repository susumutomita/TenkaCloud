import type { SystemSetting } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('settings-service');

export interface CreateSettingInput {
  key: string;
  value: unknown;
  category: string;
  updatedBy?: string;
}

export interface UpdateSettingInput {
  value: unknown;
  updatedBy?: string;
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
  async createSetting(input: CreateSettingInput): Promise<SystemSetting> {
    logger.info(
      { key: input.key, category: input.category },
      '設定を作成します'
    );

    const setting = await prisma.systemSetting.create({
      data: {
        key: input.key,
        value: input.value as object,
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
        value: input.value as object,
        updatedBy: input.updatedBy,
      },
    });

    logger.info({ settingId: setting.id }, '設定を更新しました');

    return setting;
  }

  async deleteSetting(key: string): Promise<void> {
    logger.info({ key }, '設定を削除します');

    await prisma.systemSetting.delete({
      where: { key },
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
