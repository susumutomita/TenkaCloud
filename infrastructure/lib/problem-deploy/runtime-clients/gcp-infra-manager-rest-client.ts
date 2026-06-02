/**
 * [ADR-027 / Issue #1411] Concrete GCP Infrastructure Manager REST client.
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
 *   - get:    GET  `/projects/{p}/locations/{l}/deployments/{name}` → `{state, ...}`
 *   - update: PATCH `/projects/{p}/locations/{l}/deployments/{name}` (LRO)
 *   - delete: DELETE `/projects/{p}/locations/{l}/deployments/{name}` (LRO)
 *   - body: `{terraformBlueprint: {gcsSource, inputValues: {key: {inputValue}}}}`
 *
 * spec が運ばない project / location は options で注入する (= per-team GCP account の onboarding が供給、
 * account-gated)。 実 account で照合する余地は outputs の正確な参照 (= revision 配下) と LRO の完了待ち
 * (= 本 client は enqueue まで、 完了は status polling で観測) — integration 相 (waterfall)。
 */

import { StatusCodes } from "http-status-codes";
import type {
  GcpCredential,
  GcpDeploymentSpec,
  GcpDeploymentState,
  GcpInfraManagerClient,
} from "../handlers/shared/runtime/gcp-infra-manager-adapter.js";

const DEFAULT_BASE_URL = "https://config.googleapis.com/v1";

export interface GcpInfraManagerRestClientOptions {
  /** deployment を置く GCP project ID (= per-team account)。 */
  readonly projectId: string;
  /** Infra Manager の location (= region、 例 asia-northeast1)。 */
  readonly location: string;
  /** base URL override (= test)。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock)。 */
  readonly fetchImpl?: typeof fetch;
}

/** Infra Manager deployment GET レスポンスの最小形 (本 client が依存する field のみ)。 */
interface InfraManagerDeployment {
  readonly state?: string;
  readonly terraformBlueprint?: { readonly inputValues?: Record<string, unknown> };
  readonly outputs?: Record<string, { readonly value?: unknown }>;
}

export function createGcpInfraManagerRestClient(
  credential: GcpCredential,
  options: GcpInfraManagerRestClientOptions,
): GcpInfraManagerClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const parent = `projects/${options.projectId}/locations/${options.location}`;

  function authHeaders(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  function blueprintBody(spec: GcpDeploymentSpec) {
    return {
      terraformBlueprint: {
        // blueprintRef = TF config の GCS URI (gs://...)。
        gcsSource: spec.blueprintRef,
        inputValues: Object.fromEntries(
          Object.entries(spec.inputs).map(([key, value]) => [key, { inputValue: value }]),
        ),
      },
    };
  }

  async function getRaw(name: string): Promise<InfraManagerDeployment | undefined> {
    const res = await doFetch(`${baseUrl}/${parent}/deployments/${name}`, {
      method: "GET",
      headers: authHeaders(false),
    });
    if (res.status === StatusCodes.NOT_FOUND) return undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GCP Infra Manager GET deployment failed: ${res.status} ${text}`.trim());
    }
    return (await res.json()) as InfraManagerDeployment;
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
      const existing = await getRaw(spec.name);
      if (existing) {
        // 既存は PATCH 更新 (LRO)。
        await mutate("PATCH", `${baseUrl}/${parent}/deployments/${spec.name}`, blueprintBody(spec));
        return;
      }
      // 新規は POST + ?deploymentId= (LRO)。
      await mutate(
        "POST",
        `${baseUrl}/${parent}/deployments?deploymentId=${encodeURIComponent(spec.name)}`,
        blueprintBody(spec),
      );
    },

    async getDeployment(name: string): Promise<GcpDeploymentState | undefined> {
      const deployment = await getRaw(name);
      if (!deployment) return undefined;
      const outputs = deployment.outputs
        ? Object.fromEntries(
            Object.entries(deployment.outputs).map(([key, out]) => [key, String(out.value ?? "")]),
          )
        : undefined;
      return {
        state: deployment.state ?? "unknown",
        ...(outputs ? { outputs } : {}),
      };
    },

    async deleteDeployment(name: string): Promise<void> {
      const res = await doFetch(`${baseUrl}/${parent}/deployments/${name}`, {
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
