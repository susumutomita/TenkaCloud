import { CfnOutput, Duration, Stack } from "aws-cdk-lib";
import {
  CfnManagedLoginBranding,
  ClientAttributes,
  OAuthScope,
  ResourceServerScope,
  UserPool,
  UserPoolClient,
  UserPoolResourceServer,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { McpOAuthConfig } from "./mcp-oauth-config.js";

/** Opt-in client on an explicitly selected existing pool; never modifies the organizer client. */
export function participantMcpCognito(
  scope: Construct,
  config: McpOAuthConfig | undefined,
): { environment: Record<string, string>; bundledData: Record<string, string> } {
  if (!config) return { environment: {}, bundledData: {} };
  const pool = UserPool.fromUserPoolId(scope, "McpExistingUserPool", config.userPoolId);
  const read = new ResourceServerScope({
    scopeName: "read",
    scopeDescription: "Read explicitly assigned participant problems and scores",
  });
  const submit = new ResourceServerScope({
    scopeName: "submit",
    scopeDescription: "Submit answers for the explicitly assigned participant team",
  });
  const resource = new UserPoolResourceServer(scope, "ParticipantMcpResource", {
    userPool: pool,
    identifier: config.resourceUrl,
    scopes: [read, submit],
  });
  const client = new UserPoolClient(scope, "ParticipantMcpClient", {
    userPool: pool,
    generateSecret: false,
    preventUserExistenceErrors: true,
    readAttributes: new ClientAttributes().withStandardAttributes({
      email: true,
      emailVerified: true,
    }),
    writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
    authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
    accessTokenValidity: Duration.minutes(5),
    idTokenValidity: Duration.minutes(5),
    refreshTokenValidity: Duration.hours(1),
    enableTokenRevocation: true,
    oAuth: {
      flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
      callbackUrls: config.callbackUrls,
      scopes: [
        OAuthScope.OPENID,
        OAuthScope.resourceServer(resource, read),
        OAuthScope.resourceServer(resource, submit),
      ],
    },
  });
  client.node.addDependency(resource);
  // The installation's existing Cognito domain uses managed login v2; branding is per client.
  new CfnManagedLoginBranding(scope, "ParticipantMcpLogin", {
    userPoolId: config.userPoolId,
    clientId: client.userPoolClientId,
    useCognitoProvidedValues: true,
  });
  new CfnOutput(Stack.of(scope), "ParticipantMcpOAuthClientId", { value: client.userPoolClientId });
  return {
    environment: { MCP_OAUTH_CLIENT_ID: client.userPoolClientId },
    bundledData: { MCP_OAUTH_CONFIG: JSON.stringify(config) },
  };
}
