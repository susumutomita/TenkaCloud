import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { GcpStsClient } from "@tenkacloud/trust-bridge";
import { createAzureDeploymentStacksRestClient } from "../../runtime-clients/azure-deployment-stacks-rest-client.js";
import {
  type AzureEntraTokenClient,
  createAzureEntraTokenClient,
} from "../../runtime-clients/azure-entra-token-client.js";
import {
  createSigV4SubjectTokenSigner,
  formatGcpSubjectToken,
  type GcpAwsSubjectTokenSigner,
} from "../../runtime-clients/gcp-aws-subject-token.js";
import { createGcpInfraManagerRestClient } from "../../runtime-clients/gcp-infra-manager-rest-client.js";
import { createGcpStsRestClient } from "../../runtime-clients/gcp-sts-rest-client.js";
import { createSakuraAppRunRestClient } from "../../runtime-clients/sakura-apprun-rest-client.js";
import {
  type AzureDeployCredential,
  getAzureCredential,
} from "../shared/azure-credential-store.js";
import { getGcpCredential } from "../shared/gcp-credential-store.js";
import {
  type AdapterDependencies,
  AZURE_ENGINE,
  AZURE_PROVIDER,
  GCP_ENGINE,
  GCP_PROVIDER,
  type ProblemRuntime,
  SAKURA_ENGINE,
  SAKURA_PROVIDER,
} from "../shared/runtime/index.js";
import { getSakuraCredential } from "../shared/sakura-credential-store.js";

/**
 * [ADR-026/027/032] 非 AWS runtime (sakura/azure/gcp) の credential 解決 + adapter context 組立を 1 module に
 * 集約する (= deploy.ts の deploy orchestration から「provider 別の認証情報解決」という別責務を切り出す、 SRP)。
 * 各 builder は注入された REST client / token client / signer に対する純 orchestration で、 SSM 読取の per-team
 * credential store を引く。 未登録は loud throw (= silent fallback 禁止)。 実 cloud API の wire は各 client 側。
 */

/** buildAdapterDependencies が必要とする DeployContext の部分集合 (= 疎結合のため narrow interface)。 */
export interface AdapterDependencyConfig {
  readonly env: string;
  readonly tenantId: string;
  readonly events: EventBridgeClient;
  readonly eventBusName: string;
  readonly ssm?: Pick<SSMClient, "send">;
  readonly sakuraAppRunBaseUrl?: string;
  readonly azureEntraTokenClient?: AzureEntraTokenClient;
  readonly gcpStsClient?: GcpStsClient;
  readonly gcpSubjectTokenSigner?: GcpAwsSubjectTokenSigner;
  readonly awsRegion?: string;
}

/** GCP の OAuth2 scope (= cloud-platform full)。 */
const GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** SA impersonation token の lifetime (= ADR-002 と揃え 1h)。 */
const GCP_SA_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * [ADR-026 / #1412] sakura/apprun の adapter context を組む。 getApiKey は per-team SSM SecureString
 * store を引き、 未登録なら loud に throw (= silent fallback 禁止)。 client は実 AppRun REST 実装を
 * credential で束ねる factory。
 */
function buildSakuraAdapterContext(
  ssm: Pick<SSMClient, "send">,
  env: string,
  tenantId: string,
  teamSlug: string,
  sakuraAppRunBaseUrl: string | undefined,
): NonNullable<AdapterDependencies["sakura"]> {
  return {
    getApiKey: async () => {
      const credential = await getSakuraCredential({ ssm, env }, tenantId, teamSlug);
      if (!credential) {
        throw new Error(
          `no Sakura API key registered for tenant ${tenantId} team ${teamSlug} ` +
            "(register it in the per-team SSM SecureString store before deploying a sakura/apprun problem)",
        );
      }
      return credential;
    },
    client: (credential) =>
      createSakuraAppRunRestClient(
        credential,
        sakuraAppRunBaseUrl ? { baseUrl: sakuraAppRunBaseUrl } : {},
      ),
  };
}

/**
 * [ADR-027 / ADR-032 / #1410] azure/bicep の adapter context を組む。 getCredential は per-team の
 * Azure deploy 設定 (app registration secret + subscription/RG) を SSM から引き、 未登録なら loud に throw、
 * client_credentials grant で ARM token を得る。 client は同 config の subscription/RG で Deployment Stacks
 * REST client を束ねる。 adapter は必ず getCredential → client の順で呼ぶので config を closure に保持する。
 */
function buildAzureAdapterContext(
  ssm: Pick<SSMClient, "send">,
  env: string,
  tenantId: string,
  teamSlug: string,
  tokenClient: AzureEntraTokenClient,
): NonNullable<AdapterDependencies["azure"]> {
  let resolved: AzureDeployCredential | undefined;
  return {
    getCredential: async () => {
      const config = await getAzureCredential({ ssm, env }, tenantId, teamSlug);
      if (!config) {
        throw new Error(
          `no Azure credential registered for tenant ${tenantId} team ${teamSlug} ` +
            "(register the app registration secret + subscription/resourceGroup in the per-team SSM SecureString store)",
        );
      }
      resolved = config;
      const accessToken = await tokenClient.getToken({
        azureTenantId: config.azureTenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
      return { accessToken };
    },
    client: (credential) => {
      // adapter は resolveClient で getCredential を await してから client を呼ぶので resolved は必ず埋まる。
      if (!resolved) {
        throw new Error("Azure adapter context: getCredential must resolve before client");
      }
      return createAzureDeploymentStacksRestClient(credential, {
        subscriptionId: resolved.subscriptionId,
        resourceGroup: resolved.resourceGroup,
        ...(resolved.location ? { location: resolved.location } : {}),
      });
    },
  };
}

/**
 * [ADR-027 / ADR-032 / #1411] gcp/infra-manager の adapter context を組む。 getCredential は per-team の
 * WIF config を SSM から引き未登録なら loud throw、 **署名鍵レス**で AWS subject token (= 署名済
 * GetCallerIdentity) を作り → GCP STS で federated token → SA impersonation で短命 access token を得る。
 * client は同 config の project/location で Infra Manager REST client を束ねる (Azure 同様 closure に config 保持)。
 */
function buildGcpAdapterContext(
  ssm: Pick<SSMClient, "send">,
  env: string,
  tenantId: string,
  teamSlug: string,
  stsClient: GcpStsClient,
  signer: GcpAwsSubjectTokenSigner,
  awsRegion: string,
): NonNullable<AdapterDependencies["gcp"]> {
  let resolved: { readonly projectId: string; readonly location: string } | undefined;
  return {
    getCredential: async () => {
      const config = await getGcpCredential({ ssm, env }, tenantId, teamSlug);
      if (!config) {
        throw new Error(
          `no GCP credential registered for tenant ${tenantId} team ${teamSlug} ` +
            "(register the WIF audience + service account + project/location in the per-team SSM SecureString store)",
        );
      }
      resolved = { projectId: config.projectId, location: config.location };
      // ADR-032: AWS identity を subject にした署名済 GetCallerIdentity (鍵レス)。
      const signed = await signer.sign({ region: awsRegion, wifAudience: config.wifAudience });
      const subjectToken = formatGcpSubjectToken(signed);
      const federated = await stsClient.exchangeToken({
        audience: config.wifAudience,
        subjectToken,
        subjectTokenType: "urn:ietf:params:aws:token-type:aws4_request",
        scope: GCP_CLOUD_PLATFORM_SCOPE,
      });
      const sa = await stsClient.generateServiceAccountToken({
        serviceAccountEmail: config.serviceAccountEmail,
        federatedToken: federated.access_token,
        lifetimeSeconds: GCP_SA_TOKEN_LIFETIME_SECONDS,
        scopes: [GCP_CLOUD_PLATFORM_SCOPE],
      });
      return { accessToken: sa.accessToken };
    },
    client: (credential) => {
      if (!resolved) {
        throw new Error("GCP adapter context: getCredential must resolve before client");
      }
      return createGcpInfraManagerRestClient(credential, {
        projectId: resolved.projectId,
        location: resolved.location,
      });
    },
  };
}

/**
 * runtime に応じた adapter 依存を組む。 aws は常に存在し、 sakura/apprun・azure/bicep・gcp/infra-manager は
 * SSM (per-team credential store) が配線されたときだけ追加する (= 未配線なら selectAdapter が reserved error)。
 */
export function buildAdapterDependencies(
  config: AdapterDependencyConfig,
  runtime: ProblemRuntime,
  teamSlug: string,
): AdapterDependencies {
  const aws = { events: config.events, eventBusName: config.eventBusName };
  if (!config.ssm) return { aws };
  if (runtime.provider === SAKURA_PROVIDER && runtime.engine === SAKURA_ENGINE) {
    return {
      aws,
      sakura: buildSakuraAdapterContext(
        config.ssm,
        config.env,
        config.tenantId,
        teamSlug,
        config.sakuraAppRunBaseUrl,
      ),
    };
  }
  if (runtime.provider === AZURE_PROVIDER && runtime.engine === AZURE_ENGINE) {
    return {
      aws,
      azure: buildAzureAdapterContext(
        config.ssm,
        config.env,
        config.tenantId,
        teamSlug,
        config.azureEntraTokenClient ?? createAzureEntraTokenClient(),
      ),
    };
  }
  if (runtime.provider === GCP_PROVIDER && runtime.engine === GCP_ENGINE) {
    return {
      aws,
      gcp: buildGcpAdapterContext(
        config.ssm,
        config.env,
        config.tenantId,
        teamSlug,
        config.gcpStsClient ?? createGcpStsRestClient(),
        config.gcpSubjectTokenSigner ?? createSigV4SubjectTokenSigner(),
        config.awsRegion ?? process.env.AWS_REGION ?? "us-east-1",
      ),
    };
  }
  return { aws };
}
