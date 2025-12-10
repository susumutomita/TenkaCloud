import { randomBytes } from 'node:crypto';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

let adminClient: KcAdminClient | null = null;
let tokenExpiresAt = 0;
// トークン有効期限の 80% で更新（5分前に期限切れするように）
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必須環境変数 ${name} が設定されていません`);
  }
  return value;
}

async function authenticateClient(client: KcAdminClient): Promise<void> {
  const clientId = getRequiredEnv('KEYCLOAK_CLIENT_ID');
  const clientSecret = getRequiredEnv('KEYCLOAK_CLIENT_SECRET');

  await client.auth({
    grantType: 'client_credentials',
    clientId,
    clientSecret,
  });

  // デフォルトのトークン有効期限は 300 秒（5分）
  // 環境変数で上書き可能
  const tokenLifetimeMs =
    (Number(process.env.KEYCLOAK_TOKEN_LIFETIME_SECONDS) || 300) * 1000;
  tokenExpiresAt = Date.now() + tokenLifetimeMs - TOKEN_REFRESH_BUFFER_MS;

  logger.info('Keycloak client authenticated');
}

export async function getKeycloakClient(): Promise<KcAdminClient> {
  const keycloakUrl = getRequiredEnv('KEYCLOAK_URL');
  const keycloakRealm = getRequiredEnv('KEYCLOAK_REALM');

  if (!adminClient) {
    adminClient = new KcAdminClient({
      baseUrl: keycloakUrl,
      realmName: keycloakRealm,
    });
    await authenticateClient(adminClient);
    return adminClient;
  }

  // トークンの有効期限が近い場合は再認証
  if (Date.now() >= tokenExpiresAt) {
    logger.info('Keycloak token expired, re-authenticating');
    await authenticateClient(adminClient);
  }

  return adminClient;
}

export interface CreateUserResult {
  keycloakId: string;
  temporaryPassword: string;
}

export async function createKeycloakUser(
  realm: string,
  email: string,
  name: string
): Promise<CreateUserResult> {
  const client = await getKeycloakClient();
  client.setConfig({ realmName: realm });

  const temporaryPassword = generateTemporaryPassword();

  const user = await client.users.create({
    realm,
    username: email,
    email,
    firstName: name,
    enabled: true,
    emailVerified: false,
    credentials: [
      {
        type: 'password',
        value: temporaryPassword,
        temporary: true,
      },
    ],
  });

  logger.info({ realm, email }, 'Keycloak user created');

  return {
    keycloakId: user.id,
    temporaryPassword,
  };
}

export async function resetKeycloakPassword(
  realm: string,
  keycloakId: string
): Promise<string> {
  const client = await getKeycloakClient();
  client.setConfig({ realmName: realm });

  const temporaryPassword = generateTemporaryPassword();

  await client.users.resetPassword({
    id: keycloakId,
    realm,
    credential: {
      type: 'password',
      value: temporaryPassword,
      temporary: true,
    },
  });

  logger.info({ realm, keycloakId }, 'Keycloak password reset');

  return temporaryPassword;
}

export async function disableKeycloakUser(
  realm: string,
  keycloakId: string
): Promise<void> {
  const client = await getKeycloakClient();
  client.setConfig({ realmName: realm });

  await client.users.update({ id: keycloakId, realm }, { enabled: false });

  logger.info({ realm, keycloakId }, 'Keycloak user disabled');
}

export async function deleteKeycloakUser(
  realm: string,
  keycloakId: string
): Promise<void> {
  const client = await getKeycloakClient();
  client.setConfig({ realmName: realm });

  await client.users.del({ id: keycloakId, realm });

  logger.info({ realm, keycloakId }, 'Keycloak user deleted');
}

function generateTemporaryPassword(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  const length = 16;
  // Rejection sampling: 256 % 67 = 55 なので、0-54 のインデックスが偏る
  // maxValid 未満の値のみ使用することでバイアスを排除
  const maxValid = Math.floor(256 / chars.length) * chars.length;
  let password = '';

  while (password.length < length) {
    const bytes = randomBytes(length - password.length);
    for (const byte of bytes) {
      if (byte < maxValid && password.length < length) {
        password += chars.charAt(byte % chars.length);
      }
    }
  }

  return password;
}
