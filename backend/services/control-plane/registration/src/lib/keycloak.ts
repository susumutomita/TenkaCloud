import { randomBytes } from 'node:crypto';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

interface KeycloakConfig {
  baseUrl: string;
  realmName: string;
  clientId: string;
  clientSecret: string;
}

// Validate required environment variables in non-development environments
function validateConfig(): KeycloakConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

  if (!clientSecret && nodeEnv === 'production') {
    throw new Error('KEYCLOAK_CLIENT_SECRET is required in production');
  }

  return {
    baseUrl: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    realmName: process.env.KEYCLOAK_REALM || 'tenkacloud',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'registration-service',
    clientSecret: clientSecret || 'secret',
  };
}

const config = validateConfig();

/**
 * Creates a new Keycloak admin client for a specific realm.
 * Each call returns a fresh client to avoid concurrent realm switching issues.
 */
export async function createKeycloakClient(
  realmName?: string
): Promise<KcAdminClient> {
  try {
    const kcAdminClient = new KcAdminClient({
      baseUrl: config.baseUrl,
      realmName: realmName || config.realmName,
    });

    await kcAdminClient.auth({
      grantType: 'client_credentials',
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    logger.info('Keycloak認証に成功しました');

    return kcAdminClient;
  } catch (error) {
    logger.error({ error }, 'Keycloak認証に失敗しました');
    throw error;
  }
}

// Legacy alias for backward compatibility
export const getKeycloakClient = createKeycloakClient;

export async function createAdminUser(
  realmName: string,
  email: string,
  name: string
): Promise<{ userId: string; temporaryPassword: string }> {
  // Create a fresh client for this realm operation
  const client = await createKeycloakClient(realmName);
  const temporaryPassword = generateTemporaryPassword();

  try {
    // Create user first
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
    });

    // Assign realm role via separate call (Keycloak API limitation)
    try {
      const role = await client.roles.findOneByName({
        realm: realmName,
        name: 'tenant-admin',
      });
      if (role) {
        await client.users.addRealmRoleMappings({
          id: user.id,
          realm: realmName,
          roles: [{ id: role.id!, name: role.name! }],
        });
      }
    } catch (roleError) {
      logger.warn(
        { error: roleError, realmName },
        'tenant-adminロールの割り当てをスキップしました'
      );
    }

    logger.info({ realmName }, '管理者ユーザーを作成しました');

    return {
      userId: user.id,
      temporaryPassword,
    };
  } catch (error) {
    logger.error({ error, realmName }, '管理者ユーザーの作成に失敗しました');
    throw error;
  }
}

/**
 * Generate a cryptographically secure temporary password.
 * Uses crypto.randomBytes with rejection sampling to avoid bias.
 */
function generateTemporaryPassword(): string {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  const length = 16;
  const charCount = chars.length;
  const maxValidByte = Math.floor(256 / charCount) * charCount;

  const password: string[] = [];
  while (password.length < length) {
    const bytes = randomBytes(64);
    for (let i = 0; i < bytes.length && password.length < length; i++) {
      const byte = bytes[i];
      if (byte < maxValidByte) {
        password.push(chars.charAt(byte % charCount));
      }
    }
  }
  return password.join('');
}

export const keycloakConfig = config;
