import KcAdminClient from '@keycloak/keycloak-admin-client';
import { createLogger } from './logger';

const logger = createLogger('keycloak-client');

interface KeycloakConfig {
  baseUrl: string;
  realmName: string;
  clientId: string;
  clientSecret: string;
}

// Load configuration from environment variables
const config: KeycloakConfig = {
  baseUrl: process.env.KEYCLOAK_URL || 'http://localhost:8080',
  realmName: process.env.KEYCLOAK_REALM || 'tenkacloud',
  clientId: process.env.KEYCLOAK_CLIENT_ID || 'tenant-management-service',
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
    logger.info('Successfully authenticated with Keycloak');

    // Periodically refresh token or re-authenticate could be handled here
    // For now, the client handles token refresh automatically for some time,
    // but in a long running process we might need to ensure validity.
    // The library usually handles token refresh if we use it correctly.

    return keycloakClient;
  } catch (error) {
    logger.error({ error }, 'Failed to authenticate with Keycloak');
    throw error;
  }
}

export const keycloakConfig = config;
