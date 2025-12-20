import type { SystemSetting } from '@tenkacloud/dynamodb';
import { systemSettingRepository } from '../lib/dynamodb';
import { createLogger } from '../lib/logger';
import { AuditService } from './audit';

const logger = createLogger('settings-service');

export interface CreateSettingInput {
  key: string;
  value: unknown;
  category: string;
  updatedBy: string;
}

export interface UpdateSettingInput {
  value: unknown;
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

    const setting = await systemSettingRepository.set({
      key: input.key,
      value: input.value,
      category: input.category,
      updatedBy: input.updatedBy,
    });

    logger.info({ key: setting.key }, '設定を作成しました');

    return setting;
  }

  async getSettingByKey(key: string): Promise<SystemSetting | null> {
    return systemSettingRepository.get(key);
  }

  async updateSetting(
    key: string,
    input: UpdateSettingInput
  ): Promise<SystemSetting> {
    logger.info({ key }, '設定を更新します');

    // DynamoDB では set で upsert される
    const existing = await systemSettingRepository.get(key);
    if (!existing) {
      throw new Error(`設定が見つかりません: ${key}`);
    }

    const setting = await systemSettingRepository.set({
      key,
      value: input.value,
      category: existing.category,
      updatedBy: input.updatedBy,
    });

    logger.info({ key: setting.key }, '設定を更新しました');

    return setting;
  }

  async deleteSetting(key: string, input: DeleteSettingInput): Promise<void> {
    logger.info({ key, userId: input.userId }, '設定を削除します');

    const existingSetting = await systemSettingRepository.get(key);

    await systemSettingRepository.delete(key);

    // 監査ログを記録
    await this.auditService.createLog({
      userId: input.userId,
      action: 'DELETE',
      resourceType: 'SETTING',
      resourceId: key,
      details: { key, category: existingSetting?.category },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    logger.info({ key }, '設定を削除しました');
  }

  async listSettings(input: ListSettingsInput): Promise<ListSettingsResult> {
    let settings: SystemSetting[];

    if (input.category) {
      settings = await systemSettingRepository.listByCategory(input.category);
    } else {
      settings = await systemSettingRepository.listAll();
    }

    // offset/limit でのページネーション（クライアント側）
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    const paginatedSettings = settings.slice(offset, offset + limit);

    return { settings: paginatedSettings, total: settings.length };
  }

  async getSettingsByCategory(category: string): Promise<SystemSetting[]> {
    return systemSettingRepository.listByCategory(category);
  }
}
