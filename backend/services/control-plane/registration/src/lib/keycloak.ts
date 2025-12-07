import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

interface KeycloakConfig {
  baseUrl: string;
  realmName: string;
  clientId: string;
  clientSecret: string;
}

const config: KeycloakConfig = {
  baseUrl: process.env.KEYCLOAK_URL || 'http://localhost:8080',
  realmName: process.env.KEYCLOAK_REALM || 'tenkacloud',
  clientId: process.env.KEYCLOAK_CLIENT_ID || 'registration-service',
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || 'secret',
};

let keycloakClient: KcAdminClient | null = null;

export async function getKeycloakClient(): Promise<KcAdminClient> {
  if (keycloakClient) {
    return keycloakClient;
  }

  try {
    const kcAdminClient = new KcAdminClient({
      baseUrl: config.baseUrl,
      realmName: config.realmName,
    });

    await kcAdminClient.auth({
      grantType: 'client_credentials',
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    keycloakClient = kcAdminClient;
    logger.info('Keycloak認証に成功しました');

    return keycloakClient;
  } catch (error) {
    logger.error({ error }, 'Keycloak認証に失敗しました');
    throw error;
  }
}

export async function createAdminUser(
  realmName: string,
  email: string,
  name: string
): Promise<{ userId: string; temporaryPassword: string }> {
  const client = await getKeycloakClient();
  const temporaryPassword = generateTemporaryPassword();

  try {
    // Switch to the tenant's realm
    client.setConfig({ realmName });

    const user = await client.users.create({
      realm: realmName,
      username: email,
      email,
      firstName: name.split(' ')[0] || name,
      lastName: name.split(' ').slice(1).join(' ') || '',
      enabled: true,
      emailVerified: true,
      credentials: [
        {
          type: 'password',
          value: temporaryPassword,
          temporary: true,
        },
      ],
      realmRoles: ['tenant-admin'],
    });

    logger.info({ email, realmName }, '管理者ユーザーを作成しました');

    return {
      userId: user.id,
      temporaryPassword,
    };
  } catch (error) {
    logger.error(
      { error, email, realmName },
      '管理者ユーザーの作成に失敗しました'
    );
    throw error;
  } finally {
    // Reset to master realm
    client.setConfig({ realmName: config.realmName });
  }
}

function generateTemporaryPassword(): string {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

export const keycloakConfig = config;
