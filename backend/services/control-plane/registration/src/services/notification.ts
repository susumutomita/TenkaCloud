import nodemailer, { type Transporter } from 'nodemailer';
import type { Tenant } from '@tenkacloud/dynamodb';
import { createLogger } from '../lib/logger';

const logger = createLogger('notification-service');

export interface NotificationService {
  sendRegistrationComplete(
    tenant: Tenant,
    adminCredentials: { email: string; temporaryPassword: string }
  ): Promise<void>;
  sendRegistrationFailed(tenant: Tenant, reason: string): Promise<void>;
}

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  from: string;
}

const emailConfig: EmailConfig = {
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth:
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
  from: process.env.SMTP_FROM || 'noreply@tenkacloud.io',
};

export class EmailNotificationService implements NotificationService {
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: emailConfig.auth,
    });
  }

  async sendRegistrationComplete(
    tenant: Tenant,
    adminCredentials: { email: string; temporaryPassword: string }
  ): Promise<void> {
    const loginUrl = `${process.env.APP_URL || 'https://app.tenkacloud.io'}/login`;

    const html = `
      <h1>TenkaCloud へようこそ！</h1>
      <p>${tenant.name} の登録が完了しました。</p>

      <h2>ログイン情報</h2>
      <ul>
        <li><strong>メールアドレス:</strong> ${adminCredentials.email}</li>
        <li><strong>仮パスワード:</strong> ${adminCredentials.temporaryPassword}</li>
      </ul>

      <p>初回ログイン時にパスワードの変更が必要です。</p>

      <p>
        <a href="${loginUrl}" style="
          display: inline-block;
          padding: 12px 24px;
          background-color: #3b82f6;
          color: white;
          text-decoration: none;
          border-radius: 6px;
        ">ログインする</a>
      </p>

      <hr />
      <p style="color: #666; font-size: 12px;">
        このメールに心当たりがない場合は、お手数ですがこのメールを削除してください。
      </p>
    `;

    try {
      await this.transporter.sendMail({
        from: emailConfig.from,
        to: adminCredentials.email,
        subject: `【TenkaCloud】${tenant.name} の登録が完了しました`,
        html,
      });

      logger.info(
        { tenantId: tenant.id, email: adminCredentials.email },
        '登録完了通知を送信しました'
      );
    } catch (error) {
      logger.error(
        { error, tenantId: tenant.id },
        '登録完了通知の送信に失敗しました'
      );
      throw error;
    }
  }

  async sendRegistrationFailed(tenant: Tenant, reason: string): Promise<void> {
    const supportEmail = process.env.SUPPORT_EMAIL || 'support@tenkacloud.io';

    const html = `
      <h1>登録処理でエラーが発生しました</h1>
      <p>${tenant.name} の登録処理中にエラーが発生しました。</p>

      <h2>エラー詳細</h2>
      <p>${reason}</p>

      <p>問題が解決しない場合は、<a href="mailto:${supportEmail}">サポート</a>までお問い合わせください。</p>

      <hr />
      <p style="color: #666; font-size: 12px;">
        テナントID: ${tenant.id}
      </p>
    `;

    try {
      await this.transporter.sendMail({
        from: emailConfig.from,
        to: tenant.adminEmail,
        subject: `【TenkaCloud】${tenant.name} の登録処理でエラーが発生しました`,
        html,
      });

      logger.info(
        { tenantId: tenant.id, email: tenant.adminEmail },
        '登録失敗通知を送信しました'
      );
    } catch (error) {
      logger.error(
        { error, tenantId: tenant.id },
        '登録失敗通知の送信に失敗しました'
      );
      // Don't throw - this is a secondary notification
    }
  }
}

// テスト用のモック実装
export class MockNotificationService implements NotificationService {
  public sentNotifications: Array<{
    type: 'complete' | 'failed';
    tenant: Tenant;
    data?: unknown;
  }> = [];

  async sendRegistrationComplete(
    tenant: Tenant,
    adminCredentials: { email: string; temporaryPassword: string }
  ): Promise<void> {
    this.sentNotifications.push({
      type: 'complete',
      tenant,
      data: adminCredentials,
    });
    logger.info({ tenantId: tenant.id }, '[Mock] 登録完了通知を送信しました');
  }

  async sendRegistrationFailed(tenant: Tenant, reason: string): Promise<void> {
    this.sentNotifications.push({
      type: 'failed',
      tenant,
      data: { reason },
    });
    logger.info({ tenantId: tenant.id }, '[Mock] 登録失敗通知を送信しました');
  }
}

// Factory function
export function createNotificationService(): NotificationService {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.USE_MOCK_EMAIL === 'true'
  ) {
    return new MockNotificationService();
  }
  return new EmailNotificationService();
}
