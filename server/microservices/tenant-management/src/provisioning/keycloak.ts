import { getKeycloakClient } from '../lib/keycloak';
import { createLogger } from '../lib/logger';

const logger = createLogger('keycloak-provisioner');

export class KeycloakProvisioner {
  async createRealm(tenantSlug: string, tenantName: string) {
    const realmName = `tenant-${tenantSlug}`;
    const kcClient = await getKeycloakClient();

    try {
      await kcClient.realms.create({
        realm: realmName,
        displayName: tenantName,
        enabled: true,
        registrationAllowed: true,
        loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false,
        resetPasswordAllowed: true,
        editUsernameAllowed: false,
      });
      logger.info({ realm: realmName }, 'Realm created');
    } catch (error: any) {
      if (error.response && error.response.status === 409) {
        logger.info({ realm: realmName }, 'Realm already exists');
      } else {
        logger.error({ error, realm: realmName }, 'Failed to create realm');
        throw error;
      }
    }
    return realmName;
  }
}
