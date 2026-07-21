/**
 * [ADR-027 / Issues #1410, #2743] Concrete Azure Deployment Stacks REST client.
 *
 * `AzureDeploymentStackClient` interface (= `handlers/shared/runtime/azure-bicep-adapter.ts` の注入境界)
 * を実 ARM Deployment Stacks REST API に実装する。 adapter は orchestration (= parameters / status 射影)
 * を持ち、 本 client は **wire 層** (= endpoint / Bearer auth / ARM body 整形) だけを担う。 Sakura REST
 * client と同方針で `handlers/` の外 (service 層) に置き `fetch` を閉じ込める (`handler-must-not-call-fetch`)。
 *
 * 認証は短命 Bearer token (= trust-bridge azure-federated-credential が WIF 交換で得た access token を
 * `AzureCredential.accessToken` で受け取る)。 本 client は token を貰うだけで federation はしない。
 *
 * API (https://learn.microsoft.com/en-us/rest/api/resources/deployment-stacks、 resource-group scope):
 *   - PUT/GET/DELETE `https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/
 *     Microsoft.Resources/deploymentStacks/{name}?api-version=2024-03-01`
 *   - body: `{location, properties: {templateLink|template, parameters, actionOnUnmanage, denySettings}}`
 *   - GET response: `properties.provisioningState` + direct-value `properties.outputs`
 *
 * spec が運ばない subscription / resourceGroup / location / api-version は options で注入する
 * (= per-team Azure account の onboarding が供給、 account-gated)。 実 account で照合する余地は body の
 * actionOnUnmanage / denySettings の既定と outputs の正確な形 (= integration 相、 waterfall)。
 */

import { StatusCodes } from "http-status-codes";
import type {
  AzureCredential,
  AzureDeploymentStackClient,
  AzureDeploymentStackSpec,
  AzureDeploymentStackState,
} from "../handlers/shared/runtime/azure-bicep-adapter.js";
import { stringifyRuntimeOutput } from "./runtime-output.js";

const DEFAULT_BASE_URL = "https://management.azure.com";
const DEFAULT_API_VERSION = "2024-03-01";
const DEFAULT_LOCATION = "japaneast";

export interface AzureDeploymentStacksRestClientOptions {
  /** Deployment Stack を置く subscription GUID (= per-team Azure account)。 */
  readonly subscriptionId: string;
  /** Deployment Stack を置く resource group 名。 */
  readonly resourceGroup: string;
  /** ARM region (= stack の location)。 省略時 japaneast。 */
  readonly location?: string;
  /** ARM api-version。 省略時 2024-03-01 (GA)。 */
  readonly apiVersion?: string;
  /** base URL override (= test / sovereign cloud)。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock)。 */
  readonly fetchImpl?: typeof fetch;
}

/** ARM Deployment Stack GET レスポンスの最小形 (本 client が依存する field のみ)。 */
interface ArmDeploymentStack {
  readonly properties?: {
    readonly provisioningState?: string;
    /** Deployment Stacks API は通常 Deployment API の `{type,value}` wrapper ではなく direct value を返す。 */
    readonly outputs?: Readonly<Record<string, unknown>>;
  };
}

export function createAzureDeploymentStacksRestClient(
  credential: AzureCredential,
  options: AzureDeploymentStacksRestClientOptions,
): AzureDeploymentStackClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const location = options.location ?? DEFAULT_LOCATION;
  const doFetch = options.fetchImpl ?? fetch;

  function stackPath(name: string): string {
    return (
      `${baseUrl}/subscriptions/${options.subscriptionId}/resourceGroups/${options.resourceGroup}` +
      `/providers/Microsoft.Resources/deploymentStacks/${name}?api-version=${apiVersion}`
    );
  }

  async function request<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response & { parsed?: T }> {
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Azure ARM ${method} deploymentStacks failed: ${res.status} ${text}`.trim());
    }
    return res;
  }

  return {
    async upsertStack(spec: AzureDeploymentStackSpec): Promise<void> {
      // ARM parameters は {name: {value}} 形。 actionOnUnmanage=deleteAll で teardown 時に resource も削除、
      // denySettings=none で competitor の操作を妨げない (= 競技環境)。 templateRef は Bicep を ARM 化した
      // templateLink URI として渡す前提。
      await request("PUT", stackPath(spec.name), {
        location,
        properties: {
          templateLink: { uri: spec.templateRef },
          parameters: Object.fromEntries(
            Object.entries(spec.parameters).map(([key, value]) => [key, { value }]),
          ),
          actionOnUnmanage: {
            resources: "delete",
            resourceGroups: "delete",
            managementGroups: "delete",
          },
          denySettings: { mode: "none" },
        },
      });
    },

    async getStack(name: string): Promise<AzureDeploymentStackState | undefined> {
      const res = await doFetch(stackPath(name), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: "application/json",
        },
      });
      if (res.status === StatusCodes.NOT_FOUND) return undefined;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Azure ARM GET deploymentStacks failed: ${res.status} ${text}`.trim());
      }
      const stack = (await res.json()) as ArmDeploymentStack;
      const provisioningState = stack.properties?.provisioningState ?? "unknown";
      const outputs = stack.properties?.outputs;
      const flattened = outputs
        ? Object.fromEntries(
            Object.entries(outputs).map(([key, value]) => [
              key,
              stringifyRuntimeOutput(value, "Azure Deployment Stacks"),
            ]),
          )
        : undefined;
      return { provisioningState, ...(flattened ? { outputs: flattened } : {}) };
    },

    async deleteStack(name: string): Promise<void> {
      const res = await doFetch(stackPath(name), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential.accessToken}` },
      });
      // 既に無ければ idempotent に成功扱い。
      if (res.status === StatusCodes.NOT_FOUND) return;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Azure ARM DELETE deploymentStacks failed: ${res.status} ${text}`.trim());
      }
    },
  };
}
