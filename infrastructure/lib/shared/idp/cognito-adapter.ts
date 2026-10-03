/**
 * Cognito SAML IdP adapter (Issues #1293 / #1294).
 *
 * Wraps the Cognito SDK for the IdP CRUD core. Both planes use this adapter;
 * the only difference is the `UserPoolId` passed at construction time.
 */

import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  UpdateIdentityProviderCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { type SamlIdpConfig, toCognitoProviderDetails } from "@tenkacloud/saml-utils";
import type { CognitoIdpAdapter } from "./core.js";

export interface CognitoIdpAdapterOptions {
  readonly client: CognitoIdentityProviderClient;
  readonly userPoolId: string;
}

export function createCognitoIdpAdapter(opts: CognitoIdpAdapterOptions): CognitoIdpAdapter {
  return {
    async createIdp(config: SamlIdpConfig): Promise<void> {
      await opts.client.send(
        new CreateIdentityProviderCommand({
          UserPoolId: opts.userPoolId,
          ProviderName: config.idpId,
          ProviderType: "SAML",
          ProviderDetails: toCognitoProviderDetails(config) as Record<string, string>,
          AttributeMapping: buildAttributeMapping(config),
          IdpIdentifiers: [],
        }),
      );
    },
    async updateIdp(config: SamlIdpConfig): Promise<void> {
      await opts.client.send(
        new UpdateIdentityProviderCommand({
          UserPoolId: opts.userPoolId,
          ProviderName: config.idpId,
          ProviderDetails: toCognitoProviderDetails(config) as Record<string, string>,
          AttributeMapping: buildAttributeMapping(config),
        }),
      );
    },
    async deleteIdp(idpId: string): Promise<void> {
      await opts.client.send(
        new DeleteIdentityProviderCommand({
          UserPoolId: opts.userPoolId,
          ProviderName: idpId,
        }),
      );
    },
  };
}

function buildAttributeMapping(config: SamlIdpConfig): Record<string, string> {
  const out: Record<string, string> = {
    email: config.attributeMapping.email,
  };
  if (config.attributeMapping.displayName) {
    out.name = config.attributeMapping.displayName;
  }
  if (config.attributeMapping.groups) {
    out["custom:samlGroups"] = config.attributeMapping.groups;
  }
  return out;
}
