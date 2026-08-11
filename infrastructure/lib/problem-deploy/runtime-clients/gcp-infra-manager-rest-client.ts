/**
 * [Issues #1411, #2745] Concrete GCP Infrastructure Manager REST client.
 *
 * `GcpInfraManagerClient` interface (= `handlers/shared/runtime/gcp-infra-manager-adapter.ts` の注入境界)
 * を実 Infrastructure Manager REST API に実装する。 adapter は orchestration (= inputs / state 射影) を
 * 持ち、 本 client は **wire 層** (= endpoint / Bearer auth / Terraform blueprint 整形) だけを担う。 Sakura /
 * Azure REST client と同方針で `handlers/` の外 (service 層) に置き `fetch` を閉じ込める。
 *
 * 認証は短命 Bearer token (= trust-bridge gcp-workload-identity が WIF 交換で得た access token を
 * `GcpCredential.accessToken` で受け取る)。 本 client は token を貰うだけで federation はしない。
 *
 * API (https://cloud.google.com/infrastructure-manager/docs/reference/rest):
 *   - base `https://config.googleapis.com/v1`
 *   - create: POST `/projects/{p}/locations/{l}/deployments?deploymentId={name}` (LRO)
 *   - get:    GET  `/projects/{p}/locations/{l}/deployments/{name}` → `{state, latestRevision}`
 *   - revision outputs: GET `/{latestRevision}` → `applyResults.outputs`
 *   - update: PATCH `/projects/{p}/locations/{l}/deployments/{name}?updateMask=...` (LRO)
 *   - delete: DELETE `/projects/{p}/locations/{l}/deployments/{name}` (LRO)
 *   - body: `{serviceAccount, terraformBlueprint: {gcsSource, inputValues}}`
 *
 * `runtime.entry` の repository-relative path を `gs://` artifact に materialize する責務は upstream (#2745)。
 * 本 wire client は未 materialize path を API に送らず fail loud する。 LRO 完了は status polling で観測する。
 */

import { StatusCodes } from "http-status-codes";
import type {
  GcpCredential,
  GcpDeploymentSpec,
  GcpDeploymentState,
  GcpInfraManagerClient,
} from "../handlers/shared/runtime/gcp-infra-manager-adapter.js";
import { stringifyRuntimeOutput } from "./runtime-output.js";

const DEFAULT_BASE_URL = "https://config.googleapis.com/v1";
const UPDATE_MASK = "terraformBlueprint,serviceAccount";

export interface GcpInfraManagerRestClientOptions {
  /** deployment を置く GCP project ID (= per-team account)。 */
  readonly projectId: string;
  /** Infra Manager が resource を actuate するときに使う service account email。 */
  readonly serviceAccountEmail: string;
  /** Infra Manager の location (= region、 例 asia-northeast1)。 */
  readonly location: string;
  /** base URL override (= test)。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock)。 */
  readonly fetchImpl?: typeof fetch;
}

/** Infra Manager Deployment GET の最小形。 outputs は Deployment ではなく Revision に属する。 */
interface InfraManagerDeployment {
  readonly state?: string;
  readonly latestRevision?: string;
}

interface InfraManagerTerraformOutput {
  readonly sensitive?: boolean;
  readonly value?: unknown;
}

/** Infra Manager Revision GET の最小形。 */
interface InfraManagerRevision {
  readonly applyResults?: {
    readonly outputs?: Readonly<Record<string, InfraManagerTerraformOutput>>;
  };
}

function assertGcsBlueprintRef(blueprintRef: string): void {
  let parsed: URL;
  try {
    parsed = new URL(blueprintRef);
  } catch {
    throw new Error(
      `GCP Infra Manager blueprintRef must be a materialized gs:// object, received '${blueprintRef}'`,
    );
  }
  if (parsed.protocol !== "gs:" || parsed.hostname.length === 0 || parsed.pathname === "/") {
    throw new Error(
      `GCP Infra Manager blueprintRef must be a materialized gs:// object, received '${blueprintRef}'`,
    );
  }
}

export function createGcpInfraManagerRestClient(
  credential: GcpCredential,
  options: GcpInfraManagerRestClientOptions,
): GcpInfraManagerClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const parent = `projects/${options.projectId}/locations/${options.location}`;
  const serviceAccount = `projects/${options.projectId}/serviceAccounts/${options.serviceAccountEmail}`;

  function authHeaders(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  function deploymentName(name: string): string {
    return `${parent}/deployments/${name}`;
  }

  function blueprintBody(spec: GcpDeploymentSpec) {
    return {
      serviceAccount,
      terraformBlueprint: {
        // #2745: upstream が repository artifact を immutable GCS object に materialize する。
        gcsSource: spec.blueprintRef,
        inputValues: Object.fromEntries(
          Object.entries(spec.inputs).map(([key, value]) => [key, { inputValue: value }]),
        ),
      },
    };
  }

  async function getOptionalJson<T>(url: string, operation: string): Promise<T | undefined> {
    const response = await doFetch(url, {
      method: "GET",
      headers: authHeaders(false),
    });
    if (response.status === StatusCodes.NOT_FOUND) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GCP Infra Manager GET ${operation} failed: ${response.status} ${text}`.trim(),
      );
    }
    return (await response.json()) as T;
  }

  function getRaw(name: string): Promise<InfraManagerDeployment | undefined> {
    return getOptionalJson(`${baseUrl}/${deploymentName(name)}`, "deployment");
  }

  function getRevision(
    deploymentId: string,
    revisionName: string,
  ): Promise<InfraManagerRevision | undefined> {
    const expectedPrefix = `${deploymentName(deploymentId)}/revisions/`;
    if (!revisionName.startsWith(expectedPrefix)) {
      throw new Error(
        `GCP Infra Manager returned an unexpected latestRevision outside deployment '${deploymentId}'`,
      );
    }
    return getOptionalJson(`${baseUrl}/${revisionName}`, "revision");
  }

  async function mutate(method: string, url: string, body: unknown): Promise<void> {
    const res = await doFetch(url, {
      method,
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `GCP Infra Manager ${method} deployment failed: ${res.status} ${text}`.trim(),
      );
    }
  }

  return {
    async upsertDeployment(spec: GcpDeploymentSpec): Promise<void> {
      // Fail before any provider read/mutation when artifact materialization was skipped.
      assertGcsBlueprintRef(spec.blueprintRef);
      const existing = await getRaw(spec.name);
      const body = blueprintBody(spec);
      if (existing) {
        await mutate(
          "PATCH",
          `${baseUrl}/${deploymentName(spec.name)}?updateMask=${encodeURIComponent(UPDATE_MASK)}`,
          { name: deploymentName(spec.name), ...body },
        );
        return;
      }
      await mutate(
        "POST",
        `${baseUrl}/${parent}/deployments?deploymentId=${encodeURIComponent(spec.name)}`,
        body,
      );
    },

    async getDeployment(name: string): Promise<GcpDeploymentState | undefined> {
      const deployment = await getRaw(name);
      if (!deployment) return undefined;

      const normalizedState = deployment.state?.toUpperCase();
      const canReadOutputs = normalizedState === "ACTIVE" || normalizedState === "SUCCEEDED";
      const revision =
        canReadOutputs && deployment.latestRevision
          ? await getRevision(name, deployment.latestRevision)
          : undefined;
      const rawOutputs = revision?.applyResults?.outputs;
      // Terraform marks potentially secret outputs explicitly. `stackOutputs` is persisted in
      // control-data and consumed by scoring/UI, so sensitive values must never enter it.
      const outputs = rawOutputs
        ? Object.fromEntries(
            Object.entries(rawOutputs)
              .filter(([, output]) => output.sensitive !== true)
              .map(([key, output]) => [
                key,
                stringifyRuntimeOutput(output.value, "GCP Infra Manager"),
              ]),
          )
        : undefined;

      return {
        state: deployment.state ?? "unknown",
        ...(outputs ? { outputs } : {}),
      };
    },

    async deleteDeployment(name: string): Promise<void> {
      const res = await doFetch(`${baseUrl}/${deploymentName(name)}`, {
        method: "DELETE",
        headers: authHeaders(false),
      });
      if (res.status === StatusCodes.NOT_FOUND) return; // idempotent
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GCP Infra Manager DELETE deployment failed: ${res.status} ${text}`.trim());
      }
    },
  };
}
