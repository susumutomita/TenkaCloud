/**
 * [ADR-026 / Issues #1412, #2746] Concrete Sakura AppRun REST client.
 *
 * The adapter owns orchestration while this service owns the current AppRun wire contract:
 * user bootstrap, Basic authentication, paginated name-to-id lookup, POST/PATCH, detail/status
 * reads, and idempotent deletion. Provider response bodies and transport errors are never
 * included in thrown errors because they may reflect credentials or user-supplied values.
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
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface SakuraApiApplication {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly public_url?: string;
}

interface SakuraApiApplicationList {
  readonly data?: readonly SakuraApiApplication[];
  readonly meta?: { readonly object_total?: number };
}

interface SakuraApiApplicationStatus {
  readonly status?: string;
}

type RequestResult<T> =
  | { readonly kind: "ok"; readonly value?: T }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" };

export function createSakuraAppRunRestClient(
  credential: SakuraCredential,
  options: SakuraAppRunRestClientOptions = {},
): SakuraAppRunClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const authHeader = `Basic ${Buffer.from(
    `${credential.accessToken}:${credential.accessTokenSecret}`,
  ).toString("base64")}`;
  let userReady: Promise<void> | undefined;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RequestResult<T>> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Sakura AppRun API ${method} ${path} request failed`);
    }

    if (response.status === StatusCodes.NOT_FOUND) return { kind: "not-found" };
    if (response.status === StatusCodes.CONFLICT) return { kind: "conflict" };
    if (!response.ok) {
      throw new Error(`Sakura AppRun API ${method} ${path} failed: ${response.status}`);
    }
    if (response.status === StatusCodes.NO_CONTENT) return { kind: "ok" };
    return { kind: "ok", value: (await response.json()) as T };
  }

  function ensureUser(): Promise<void> {
    if (userReady) return userReady;
    userReady = (async () => {
      const current = await request<unknown>("GET", "/user");
      if (current.kind === "ok") return;
      if (current.kind === "conflict") {
        throw new Error("Sakura AppRun API GET /user conflicted");
      }
      const created = await request<unknown>("POST", "/user");
      if (created.kind === "not-found") {
        throw new Error("Sakura AppRun API POST /user returned not-found");
      }
      // A concurrent initializer may win; POST 409 means the required user now exists.
    })().catch((error: unknown) => {
      userReady = undefined;
      throw error;
    });
    return userReady;
  }

  function applicationPath(id: string): string {
    return `/applications/${encodeURIComponent(id)}`;
  }

  function listPath(pageNum: number): string {
    const query = new URLSearchParams({
      page_num: String(pageNum),
      page_size: String(APPLICATION_LIST_PAGE_SIZE),
      sort_field: "created_at",
      sort_order: "asc",
    });
    return `/applications?${query.toString()}`;
  }

  async function readApplicationPage(pageNum: number): Promise<SakuraApiApplicationList> {
    const path = listPath(pageNum);
    let result = await request<SakuraApiApplicationList>("GET", path);
    if (result.kind === "not-found") {
      // Existing accounts list applications directly. A newly enabled account can require one
      // user initialization, so bootstrap only after the ordinary list call proves it necessary.
      await ensureUser();
      result = await request<SakuraApiApplicationList>("GET", path);
    }
    if (result.kind === "conflict") {
      throw new Error(`Sakura AppRun API GET ${path} conflicted`);
    }
    if (result.kind === "not-found") {
      throw new Error(`Sakura AppRun API GET ${path} returned not-found`);
    }
    if (result.value === undefined) {
      throw new Error(`Sakura AppRun API GET ${path} returned no document`);
    }
    return result.value;
  }

  async function listApplications(): Promise<SakuraApiApplication[]> {
    const applications: SakuraApiApplication[] = [];
    for (let pageNum = 1; ; pageNum += 1) {
      const response = await readApplicationPage(pageNum);
      const page = [...(response.data ?? [])];
      applications.push(...page);
      const total = response.meta?.object_total;
      if (page.length === 0) break;
      if (typeof total === "number" && applications.length >= total) break;
      if (total === undefined && page.length < APPLICATION_LIST_PAGE_SIZE) break;
    }
    return applications;
  }

  async function findByName(name: string): Promise<SakuraApiApplication[]> {
    return (await listApplications())
      .filter((application) => application.name === name)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function patchExistingApplication(
    spec: SakuraAppRunSpec,
    existing: SakuraApiApplication,
  ): Promise<"done" | "retry"> {
    const path = applicationPath(existing.id);
    const patched = await request<unknown>("PATCH", path, patchBody(spec));
    if (patched.kind === "ok") return "done";
    if (patched.kind === "conflict") {
      throw new Error(`Sakura AppRun API PATCH ${path} conflicted`);
    }
    return "retry";
  }

  async function createApplication(spec: SakuraAppRunSpec): Promise<"done" | "retry"> {
    const created = await request<unknown>("POST", "/applications", createBody(spec));
    if (created.kind === "ok") return "done";
    if (created.kind === "not-found") {
      throw new Error("Sakura AppRun API POST /applications returned not-found");
    }
    // POST 409 means another worker created the same name. Re-list and PATCH it.
    return "retry";
  }

  function component(spec: SakuraAppRunSpec) {
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

  function createBody(spec: SakuraAppRunSpec) {
    return {
      name: spec.name,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [component(spec)],
    };
  }

  function patchBody(spec: SakuraAppRunSpec) {
    return {
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      port: DEFAULT_PORT,
      min_scale: DEFAULT_MIN_SCALE,
      max_scale: DEFAULT_MAX_SCALE,
      components: [component(spec)],
      all_traffic_available: true,
    };
  }

  return {
    async upsertApplication(spec: SakuraAppRunSpec): Promise<void> {
      for (let attempt = 0; attempt < UPSERT_MAX_ATTEMPTS; attempt += 1) {
        const existing = (await findByName(spec.name))[0];
        const outcome = existing
          ? await patchExistingApplication(spec, existing)
          : await createApplication(spec);
        if (outcome === "done") return;
      }
      throw new Error("Sakura AppRun application upsert did not converge");
    },

    async getApplication(name: string): Promise<SakuraApplicationState | undefined> {
      const existing = (await findByName(name))[0];
      if (!existing) return undefined;
      const path = applicationPath(existing.id);
      const detail = await request<SakuraApiApplication>("GET", path);
      if (detail.kind !== "ok" || detail.value === undefined) return undefined;
      const status = await request<SakuraApiApplicationStatus>("GET", `${path}/status`);
      if (status.kind !== "ok" || status.value === undefined) return undefined;
      const publicUrl = detail.value.public_url ?? existing.public_url;
      return {
        status: status.value.status ?? detail.value.status ?? existing.status ?? "unknown",
        ...(publicUrl ? { publicUrl } : {}),
      };
    },

    async deleteApplication(name: string): Promise<void> {
      for (const application of await findByName(name)) {
        const deleted = await request<void>("DELETE", applicationPath(application.id));
        if (deleted.kind === "conflict") {
          throw new Error(`Sakura AppRun API DELETE ${applicationPath(application.id)} conflicted`);
        }
        // `ok` and `not-found` are both successful idempotent teardown outcomes.
      }
    },
  };
}
