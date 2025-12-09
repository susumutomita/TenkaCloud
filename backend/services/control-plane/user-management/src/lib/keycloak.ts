import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

let adminClient: KcAdminClient | null = null;

export async function getKeycloakClient(): Promise<KcAdminClient> {
  if (adminClient) {
    return adminClient;
  }

  adminClient = new KcAdminClient({
    baseUrl: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    realmName: process.env.KEYCLOAK_REALM || 'master',
  });

  await adminClient.auth({
    grantType: 'client_credentials',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'admin-cli',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
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
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
