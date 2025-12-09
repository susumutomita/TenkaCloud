import { randomBytes } from 'node:crypto';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

let adminClient: KcAdminClient | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必須環境変数 ${name} が設定されていません`);
  }
  return value;
}

export async function getKeycloakClient(): Promise<KcAdminClient> {
  if (adminClient) {
    return adminClient;
  }

  const keycloakUrl = getRequiredEnv('KEYCLOAK_URL');
  const keycloakRealm = getRequiredEnv('KEYCLOAK_REALM');
  const clientId = getRequiredEnv('KEYCLOAK_CLIENT_ID');
  const clientSecret = getRequiredEnv('KEYCLOAK_CLIENT_SECRET');

  adminClient = new KcAdminClient({
    baseUrl: keycloakUrl,
    realmName: keycloakRealm,
  });

  await adminClient.auth({
    grantType: 'client_credentials',
    clientId,
    clientSecret,
  });

  logger.info('Keycloak client authenticated');
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

function generateTemporaryPassword(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  const bytes = randomBytes(16);
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(bytes[i] % chars.length);
  }
  return password;
}
