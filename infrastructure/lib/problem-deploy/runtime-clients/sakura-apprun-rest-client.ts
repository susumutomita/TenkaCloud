/**
 * [ADR-026 / Issues #1412, #2746] Concrete Sakura AppRun REST client.
 *
 * `SakuraAppRunClient` interface (= `handlers/shared/runtime/sakura-apprun-adapter.ts` の注入境界) を
 * 実 AppRun 共用型 REST API に対して実装する。adapter は orchestration (= image/env の組立、status の
 * 6-state 射影) を持ち、本 client は wire 層 (= endpoint / Basic auth / JSON / name↔id 解決) だけを担う。
 *
 * API (AppRun OpenAPI 1.3.0 / sacloud/apprun-api-go と整合):
 *   - base: `https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api`
 *   - auth: HTTP Basic (user = Access Token, password = Access Token Secret)
 *   - create: `POST /applications`
 *   - update: `PATCH /applications/{id}` (`name` は patch body に含めない)
 *   - fresh status: `GET /applications/{id}/status`
 *   - applications は id ベース。interface は name ベースなので pagination 付き list から exact-name
 *     match を収集し、重複時も id 昇順で同じ application を選ぶ。
 */

import { StatusCodes } from "http-status-codes";
import type {
  SakuraApplicationState,
  SakuraAppRunClient,
  SakuraAppRunSpec,
  SakuraCredential,
} from "../handlers/shared/runtime/sakura-apprun-adapter.js";

const DEFAULT_BASE_URL = "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api";
const DEFAULT_PORT = 8080;
const DEFAULT_MIN_SCALE = 0;
const DEFAULT_MAX_SCALE = 1;
const DEFAULT_MAX_CPU = "0.5";
const DEFAULT_MAX_MEMORY = "1Gi";
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_COMPONENT_NAME = "main";
const APPLICATION_LIST_PAGE_SIZE = 100;
const UPSERT_MAX_ATTEMPTS = 3;

export interface SakuraAppRunRestClientOptions {
  /** base URL override (= test / 環境別)。省略時は本番 AppRun 共用型。 */
  readonly baseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock、本番は global fetch)。 */
  readonly fetchImpl?: typeof fetch;
}

interface SakuraApiApplication {
  readonly id: string;
  readonly name: string;
  readonly public_url?: string;
}

interface SakuraApiApplicationList {
  readonly data?: readonly SakuraApiApplication[];
  readonly meta?: {
    readonly object_total?: number;
  };
}

interface SakuraApiApplicationStatus {
  readonly status: string;
}

interface RequestOptions {
  readonly body?: unknown;
}

type RequestResult<T> =
  | { readonly kind: "ok"; readonly value: T | undefined }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" };

/**
 * credential を束ねた `SakuraAppRunClient` を返す factory。deploy worker (composition root) が
 * `SakuraAppRunAdapterContext.client` としてこれを渡す。
 */
export function createSakuraAppRunRestClient(
  credential: SakuraCredential,
  options: SakuraAppRunRestClientOptions = {},
): SakuraAppRunClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const authHeader = `Basic ${Buffer.from(
    `${credential.accessToken}:${credential.accessTokenSecret}`,
  ).toString("base64")}`;
  let ensureUserPromise: Promise<void> | undefined;

  async function request<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<RequestResult<T>> {
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
      // fetch の Error/cause を連結しない。実装依存 request dump への Basic credential 混入を防ぐ。
      throw new Error(`Sakura AppRun API ${method} ${path} request failed`);
    }

    if (response.status === StatusCodes.NOT_FOUND) return { kind: "not-found" };
    if (response.status === StatusCodes.CONFLICT) return { kind: "conflict" };
    if (!response.ok) {
      // response body は入力値を反射し得るため載せない。method/path/status だけで診断する。
      throw new Error(`Sakura AppRun API ${method} ${path} failed: ${response.status}`);
    }
    if (response.status === StatusCodes.NO_CONTENT) return { kind: "ok", value: undefined };
    return { kind: "ok", value: (await response.json()) as T };
  }

  async function requestRequired<T>(method: string, path: string): Promise<T> {
    const result = await request<T>(method, path);
    if (result.kind !== "ok" || result.value === undefined) {
      throw new Error(`Sakura AppRun API ${method} ${path} returned no document`);
    }
    return result.value;
  }

  /** AppRun は初回利用前に user resource が必要。1 client instance につき 1 度だけ確認する。 */
  function ensureUser(): Promise<void> {
    if (ensureUserPromise) return ensureUserPromise;
    ensureUserPromise = (async () => {
      const current = await request<unknown>("GET", "/user");
      if (current.kind === "ok") return;
      if (current.kind !== "not-found") {
        throw new Error("Sakura AppRun user lookup conflicted unexpectedly");
      }
      const created = await request<unknown>("POST", "/user");
      if (created.kind === "ok" || created.kind === "conflict") return;
      throw new Error("Sakura AppRun user creation returned not-found");
    })().catch((error: unknown) => {
      ensureUserPromise = undefined;
      throw error;
    });
    return ensureUserPromise;
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
      const listed = await requestRequired<SakuraApiApplicationList>(
        "GET",
        applicationListPath(pageNum),
      );
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

  async function findMatchesByName(name: string): Promise<SakuraApiApplication[]> {
    return (await listApplications())
      .filter((application) => application.name === name)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function findByName(name: string): Promise<SakuraApiApplication | undefined> {
    return (await findMatchesByName(name))[0];
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

  function buildPatchBody(spec: SakuraAppRunSpec) {
    return {
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [buildComponent(spec)],
      all_traffic_available: true,
    };
  }

  async function createApplication(spec: SakuraAppRunSpec): Promise<"created" | "conflict"> {
    const result = await request<unknown>("POST", "/applications", {
      body: buildCreateBody(spec),
    });
    if (result.kind === "ok") return "created";
    if (result.kind === "conflict") return "conflict";
    throw new Error("Sakura AppRun application collection returned not-found");
  }

  async function patchApplication(
    application: SakuraApiApplication,
    spec: SakuraAppRunSpec,
  ): Promise<"patched" | "not-found"> {
    const path = applicationPath(application.id);
    const result = await request<unknown>("PATCH", path, { body: buildPatchBody(spec) });
    if (result.kind === "ok") return "patched";
    if (result.kind === "not-found") return "not-found";
    throw new Error(`Sakura AppRun API PATCH ${path} conflicted`);
  }

  return {
    async upsertApplication(spec: SakuraAppRunSpec): Promise<void> {
      await ensureUser();
      for (let attempt = 0; attempt < UPSERT_MAX_ATTEMPTS; attempt += 1) {
        const existing = await findByName(spec.name);
        if (existing) {
          if ((await patchApplication(existing, spec)) === "patched") return;
          continue;
        }
        if ((await createApplication(spec)) === "created") return;
      }
      throw new Error("Sakura AppRun application upsert did not converge");
    },

    async getApplication(name: string): Promise<SakuraApplicationState | undefined> {
      await ensureUser();
      const existing = await findByName(name);
      if (!existing) return undefined;
      const path = applicationPath(existing.id);
      const application = await request<SakuraApiApplication>("GET", path);
      if (application.kind !== "ok" || !application.value) return undefined;
      const status = await request<SakuraApiApplicationStatus>("GET", `${path}/status`);
      if (status.kind !== "ok" || !status.value) return undefined;
      return {
        status: status.value.status,
        ...(application.value.public_url ? { publicUrl: application.value.public_url } : {}),
      };
    },

    async deleteApplication(name: string): Promise<void> {
      await ensureUser();
      const matches = await findMatchesByName(name);
      for (const application of matches) {
        const result = await request<void>("DELETE", applicationPath(application.id));
        if (result.kind === "conflict") {
          throw new Error(
            `Sakura AppRun API DELETE ${applicationPath(application.id)} conflicted`,
          );
        }
        // ok / not-found are both successful teardown outcomes.
      }
    },
  };
}
