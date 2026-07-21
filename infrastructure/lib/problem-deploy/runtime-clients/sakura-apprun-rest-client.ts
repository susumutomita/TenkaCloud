/**
 * [ADR-026 / Issues #1412, #2746] Concrete Sakura AppRun REST client.
 *
 * `SakuraAppRunClient` interface (= `handlers/shared/runtime/sakura-apprun-adapter.ts` の注入境界) を
 * 実 AppRun 共用型 REST API に対して実装する。 adapter は orchestration (= image/env の組立、 status の
 * 6-state 射影) を持ち、 本 client は **wire 層** (= endpoint / Basic auth / JSON 整形 / name↔id 解決) だけを担う。
 *
 * 配置: `handlers/` の外 (= service / repository 層) に置く。 `handler-must-not-call-fetch` 規約どおり
 * `fetch` は handler に書かず本 client に閉じ込め、 composition root (deploy worker) が factory を注入する。
 *
 * API (AppRun OpenAPI 1.3.0 / sacloud/apprun-api-go と整合):
 *   - base: `https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api`
 *   - auth: HTTP Basic (user = Access Token, password = Access Token Secret)
 *   - create: `POST /applications`
 *   - update: `PATCH /applications/{id}` (`name` は patch body に含めない)
 *   - fresh status: `GET /applications/{id}/status`
 *   - applications は id ベース。 interface は name ベースなので、 pagination 付き list から exact-name
 *     match を収集し、重複時も id 昇順で同じ application を選ぶ。
 */

import { StatusCodes } from "http-status-codes";
import type {
  SakuraApplicationState,
  SakuraAppRunClient,
  SakuraAppRunSpec,
  SakuraCredential,
} from "../handlers/shared/runtime/sakura-apprun-adapter.js";

/** AppRun 共用型 REST API の base path。 */
const DEFAULT_BASE_URL = "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api";

/**
 * SakuraAppRunSpec が運ばない deploy body の必須 field の default。 OpenAPI の enum で許可された
 * 最小値を使い、1 team 1 instance + scale-to-zero で競技環境のコストを抑える。
 */
const DEFAULT_PORT = 8080;
const DEFAULT_MIN_SCALE = 0;
const DEFAULT_MAX_SCALE = 1;
const DEFAULT_MAX_CPU = "0.5";
const DEFAULT_MAX_MEMORY = "1Gi";
const DEFAULT_TIMEOUT_SECONDS = 60;
/** component 名は AppRun 内部の識別子。 1 component 構成なので固定名で十分。 */
const DEFAULT_COMPONENT_NAME = "main";
const APPLICATION_LIST_PAGE_SIZE = 100;

export interface SakuraAppRunRestClientOptions {
  /** base URL override (= test / 環境別)。 省略時は本番 AppRun 共用型。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock、 本番は global fetch)。 */
  readonly fetchImpl?: typeof fetch;
}

/** AppRun list / read が返す application の最小形 (本 client が依存する field のみ)。 */
interface SakuraApiApplication {
  readonly id: string;
  readonly name: string;
  readonly public_url?: string;
}

interface SakuraApiApplicationList {
  readonly data?: readonly SakuraApiApplication[];
  readonly meta?: {
    readonly object_total?: number;
    readonly page_num?: number;
    readonly page_size?: number;
  };
}

interface SakuraApiApplicationStatus {
  readonly status: string;
  readonly message?: string;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly allowNotFound?: boolean;
}

/**
 * credential を束ねた `SakuraAppRunClient` を返す factory。 deploy worker (composition root) が
 * `SakuraAppRunAdapterContext.client` としてこれを渡す。
 */
export function createSakuraAppRunRestClient(
  credential: SakuraCredential,
  options: SakuraAppRunRestClientOptions = {},
): SakuraAppRunClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  // Basic 認証: Access Token : Secret を base64。 ADR-026 D3 (静的 API key)。
  const authHeader = `Basic ${Buffer.from(`${credential.accessToken}:${credential.accessTokenSecret}`).toString("base64")}`;

  async function request<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions & { readonly allowNotFound: true },
  ): Promise<T | undefined>;
  async function request<T>(
    method: string,
    path: string,
    requestOptions?: RequestOptions & { readonly allowNotFound?: false },
  ): Promise<T>;
  async function request<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<T | undefined> {
    const serializedBody =
      requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          ...(serializedBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
    } catch {
      // fetch の Error/cause を連結しない。実装依存の request dump に Basic credential が混ざるのを防ぐ。
      throw new Error(`Sakura AppRun API ${method} ${path} request failed`);
    }

    if (response.status === StatusCodes.NOT_FOUND && requestOptions.allowNotFound) {
      return undefined;
    }
    if (!response.ok) {
      // API response body は validation input を反射し得るためログへ載せない。method/path/status だけで診断する。
      throw new Error(`Sakura AppRun API ${method} ${path} failed: ${response.status}`);
    }
    if (response.status === StatusCodes.NO_CONTENT) return undefined;
    return (await response.json()) as T;
  }

  function applicationPath(id: string): string {
    return `/applications/${encodeURIComponent(id)}`;
  }

  function applicationListPath(pageNum: number): string {
    const query = new URLSearchParams({
      page_num: String(pageNum),
      page_size: String(APPLICATION_LIST_PAGE_SIZE),
      sort_field: "created_at",
      sort_order: "asc",
    });
    return `/applications?${query.toString()}`;
  }

  async function listApplications(): Promise<SakuraApiApplication[]> {
    const applications: SakuraApiApplication[] = [];
    let pageNum = 1;

    for (;;) {
      const listed = await request<SakuraApiApplicationList>("GET", applicationListPath(pageNum));
      const page = [...(listed.data ?? [])];
      applications.push(...page);

      if (page.length === 0) break;
      const objectTotal = listed.meta?.object_total;
      if (typeof objectTotal === "number" && applications.length >= objectTotal) break;
      if (typeof objectTotal !== "number" && page.length < APPLICATION_LIST_PAGE_SIZE) break;
      pageNum += 1;
    }

    return applications;
  }

  /** name で application を 1 件解決。重複時も id 昇順で決定的に同じ対象を返す。 */
  async function findByName(name: string): Promise<SakuraApiApplication | undefined> {
    const matches = (await listApplications()).filter((application) => application.name === name);
    matches.sort((left, right) => left.id.localeCompare(right.id));
    return matches[0];
  }

  function buildComponent(spec: SakuraAppRunSpec) {
    return {
      name: DEFAULT_COMPONENT_NAME,
      max_cpu: DEFAULT_MAX_CPU,
      max_memory: DEFAULT_MAX_MEMORY,
      deploy_source: { container_registry: { image: spec.image } },
      env: Object.entries(spec.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    };
  }

  /** spec → OpenAPI `postApplicationBody`。 */
  function buildCreateBody(spec: SakuraAppRunSpec) {
    return {
      name: spec.name,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [buildComponent(spec)],
    };
  }

  /** spec → OpenAPI `patchApplicationBody`。name は immutable なので含めない。 */
  function buildPatchBody(spec: SakuraAppRunSpec) {
    return {
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [buildComponent(spec)],
      // PATCH で作られた最新 version へ traffic を移し、re-deploy を実際の rollout にする。
      all_traffic_available: true,
    };
  }

  async function createApplication(spec: SakuraAppRunSpec): Promise<void> {
    await request("POST", "/applications", { body: buildCreateBody(spec) });
  }

  async function patchApplication(
    application: SakuraApiApplication,
    spec: SakuraAppRunSpec,
    allowNotFound: boolean,
  ): Promise<boolean> {
    const path = applicationPath(application.id);
    if (allowNotFound) {
      const result = await request<unknown>("PATCH", path, {
        body: buildPatchBody(spec),
        allowNotFound: true,
      });
      return result !== undefined;
    }
    await request("PATCH", path, { body: buildPatchBody(spec) });
    return true;
  }

  return {
    async upsertApplication(spec: SakuraAppRunSpec): Promise<void> {
      const existing = await findByName(spec.name);
      if (!existing) {
        await createApplication(spec);
        return;
      }

      // list と PATCH の間で消えた場合は再解決し、存在すれば新 id を更新、無ければ作成へ収束する。
      if (await patchApplication(existing, spec, true)) return;
      const replacement = await findByName(spec.name);
      if (replacement) {
        await patchApplication(replacement, spec, false);
        return;
      }
      await createApplication(spec);
    },

    async getApplication(name: string): Promise<SakuraApplicationState | undefined> {
      const existing = await findByName(name);
      if (!existing) return undefined;
      const path = applicationPath(existing.id);

      // list の time-of-check と read/status の time-of-use の間に消えていれば不在扱い。
      const application = await request<SakuraApiApplication>("GET", path, {
        allowNotFound: true,
      });
      if (!application) return undefined;
      const status = await request<SakuraApiApplicationStatus>("GET", `${path}/status`, {
        allowNotFound: true,
      });
      if (!status) return undefined;

      return {
        status: status.status,
        ...(application.public_url ? { publicUrl: application.public_url } : {}),
      };
    },

    async deleteApplication(name: string): Promise<void> {
      const existing = await findByName(name);
      if (!existing) return;
      // list 後に別 worker / operator が消していても teardown は成功 (= idempotent)。
      await request<void>("DELETE", applicationPath(existing.id), { allowNotFound: true });
    },
  };
}
