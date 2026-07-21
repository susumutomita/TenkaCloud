/**
 * [ADR-026 / Issues #1412, #2746] Concrete Sakura AppRun REST client.
 *
 * `SakuraAppRunClient` interface (= `handlers/shared/runtime/sakura-apprun-adapter.ts` の注入境界) を
 * AppRun 共用型 REST API に実装する。 adapter は orchestration (= image/env の組立、 status の
 * 6-state 射影) を持ち、 本 client は **wire 層** (= endpoint / Basic auth / JSON 整形 / name↔id 解決) だけを担う。
 *
 * 配置: `handlers/` の外 (= service / repository 層) に置く。 `handler-must-not-call-fetch` 規約どおり
 * `fetch` は handler に書かず本 client に閉じ込め、 composition root (deploy worker) が factory を注入する。
 *
 * API (current generated sacloud/apprun OpenAPI client と整合):
 *   - base: `https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api`
 *   - auth: HTTP Basic (user = Access Token, password = Access Token Secret)
 *   - create: POST `/applications`
 *   - update: PATCH `/applications/{id}`
 *   - detail: GET `/applications/{id}`
 *   - status: GET `/applications/{id}/status`
 *   - delete: DELETE `/applications/{id}`
 *
 * applications は id ベースだが adapter contract は name ベースなので、 list → name 一致で id を解決する。
 * list/detail/status 間で application が消える race は not-found として扱い、 lifecycle polling を壊さない。
 */

import { StatusCodes } from "http-status-codes";
import type {
  SakuraApplicationState,
  SakuraAppRunClient,
  SakuraAppRunSpec,
  SakuraCredential,
} from "../handlers/shared/runtime/sakura-apprun-adapter.js";

const DEFAULT_BASE_URL = "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api";

/**
 * AppRun の current API enum に含まれる最小 resource。 競技問題の container は HTTP を単一 port で serve し、
 * 1 team 1 instance で足りる前提 (= 最小コスト)。
 */
const DEFAULT_PORT = 8080;
const DEFAULT_MIN_SCALE = 0;
const DEFAULT_MAX_SCALE = 1;
const DEFAULT_MAX_CPU = "0.5";
const DEFAULT_MAX_MEMORY = "1Gi";
const DEFAULT_TIMEOUT_SECONDS = 60;
/** component 名は AppRun 内部の識別子。 1 component 構成なので固定名で十分。 */
const DEFAULT_COMPONENT_NAME = "main";

export interface SakuraAppRunRestClientOptions {
  /** base URL override (= test / 環境別)。 省略時は本番 AppRun 共用型。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock、 本番は global fetch)。 */
  readonly fetchImpl?: typeof fetch;
}

/** AppRun list / detail が返す application の最小形。 */
interface SakuraApiApplication {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly public_url?: string;
}

interface SakuraApiApplicationStatus {
  readonly status?: string;
}

export function createSakuraAppRunRestClient(
  credential: SakuraCredential,
  options: SakuraAppRunRestClientOptions = {},
): SakuraAppRunClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const authHeader = `Basic ${Buffer.from(`${credential.accessToken}:${credential.accessTokenSecret}`).toString("base64")}`;

  async function performRequest(method: string, path: string, body?: unknown): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function decodeResponse<T>(response: Response, method: string, path: string): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Sakura AppRun API ${method} ${path} failed: ${response.status} ${text}`.trim(),
      );
    }
    if (response.status === StatusCodes.NO_CONTENT) return undefined as T;
    return (await response.json()) as T;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return decodeResponse<T>(await performRequest(method, path, body), method, path);
  }

  async function requestOptional<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    const response = await performRequest(method, path, body);
    if (response.status === StatusCodes.NOT_FOUND) return undefined;
    return decodeResponse<T>(response, method, path);
  }

  /** name で application を 1 件解決 (= name↔id mapping)。 不在は undefined。 */
  async function findByName(name: string): Promise<SakuraApiApplication | undefined> {
    const listed = await request<{ data?: SakuraApiApplication[] }>("GET", "/applications");
    return (listed.data ?? []).find((app) => app.name === name);
  }

  /** spec → AppRun create/patch body。 env(record) → [{key,value}]、 image → component。 */
  function buildBody(spec: SakuraAppRunSpec) {
    return {
      name: spec.name,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [
        {
          name: DEFAULT_COMPONENT_NAME,
          max_cpu: DEFAULT_MAX_CPU,
          max_memory: DEFAULT_MAX_MEMORY,
          deploy_source: { container_registry: { image: spec.image } },
          env: Object.entries(spec.env).map(([key, value]) => ({ key, value })),
        },
      ],
    };
  }

  return {
    async upsertApplication(spec: SakuraAppRunSpec): Promise<void> {
      const existing = await findByName(spec.name);
      const body = buildBody(spec);
      if (existing) {
        await request("PATCH", `/applications/${existing.id}`, body);
        return;
      }
      await request("POST", "/applications", body);
    },

    async getApplication(name: string): Promise<SakuraApplicationState | undefined> {
      const existing = await findByName(name);
      if (!existing) return undefined;

      const application = await requestOptional<SakuraApiApplication>(
        "GET",
        `/applications/${existing.id}`,
      );
      if (!application) return undefined;
      const liveStatus = await requestOptional<SakuraApiApplicationStatus>(
        "GET",
        `/applications/${existing.id}/status`,
      );
      if (!liveStatus) return undefined;

      const publicUrl = application.public_url ?? existing.public_url;
      return {
        status: liveStatus.status ?? application.status ?? existing.status ?? "unknown",
        ...(publicUrl ? { publicUrl } : {}),
      };
    },

    async deleteApplication(name: string): Promise<void> {
      const existing = await findByName(name);
      if (!existing) return;
      // list 後に削除済みでも idempotent success。
      await requestOptional<void>("DELETE", `/applications/${existing.id}`);
    },
  };
}
