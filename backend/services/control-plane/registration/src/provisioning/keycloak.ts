import { getKeycloakClient } from '../lib/keycloak';
import { createLogger } from '../lib/logger';

const logger = createLogger('keycloak-provisioner');

export class KeycloakProvisioner {
  async createRealm(tenantSlug: string, tenantName: string): Promise<string> {
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
      logger.info({ realm: realmName }, 'Realmを作成しました');
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      if (err.response?.status === 409) {
        logger.info({ realm: realmName }, 'Realmは既に存在します');
      } else {
        logger.error({ error, realm: realmName }, 'Realm作成に失敗しました');
        throw error;
      }
    }
    return realmName;
  }
}
