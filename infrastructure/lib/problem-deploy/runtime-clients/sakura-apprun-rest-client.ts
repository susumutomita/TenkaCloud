/**
 * [ADR-026 / Issue #1412] Concrete Sakura AppRun REST client.
 *
 * `SakuraAppRunClient` interface (= `handlers/shared/runtime/sakura-apprun-adapter.ts` の注入境界) を
 * 実 AppRun 共用型 REST API に対して実装する。 adapter は orchestration (= image/env の組立、 status の
 * 6-state 射影) を持ち、 本 client は **wire 層** (= endpoint / Basic auth / JSON 整形 / name↔id 解決) だけを担う。
 *
 * 配置: `handlers/` の外 (= service / repository 層) に置く。 `handler-must-not-call-fetch` 規約どおり
 * `fetch` は handler に書かず本 client に閉じ込め、 composition root (deploy worker) が factory を注入する。
 *
 * API (https://manual.sakura.ad.jp/api/cloud/apprun/、 sacloud/apprun-api-go と整合):
 *   - base: `https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api`
 *   - auth: HTTP Basic (user = Access Token, password = Access Token Secret)
 *   - applications は **id ベース** (create が id を返し、 read/delete は id 指定)。 本 client の interface は
 *     name ベースなので、 list → name 一致で id を解決してから id ベース API を叩く (= name↔id mapping)。
 *
 * 実 account onboarding で確認する余地 (= waterfall の integration 相): list envelope (`data`/`meta`) の
 * 正確な形、 public URL の field 名 (`public_url` を仮定)、 deploy body の必須 default (port / scale /
 * cpu / memory)。 いずれも本 client の 1 箇所に局所化し、 unit test は **request 整形 + response 射影** を pin する。
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
 * SakuraAppRunSpec が運ばない deploy body の必須 field の default。 競技問題の container は HTTP を
 * 単一 port で serve し、 1 team 1 インスタンスで足りる前提 (= 最小コスト)。 実 account で調整する。
 */
const DEFAULT_PORT = 8080;
const DEFAULT_MIN_SCALE = 0; // scale-to-zero でアイドルコストを抑える
const DEFAULT_MAX_SCALE = 1;
const DEFAULT_MAX_CPU = "0.1";
const DEFAULT_MAX_MEMORY = "256Mi";
const DEFAULT_TIMEOUT_SECONDS = 60;
/** component 名は AppRun 内部の識別子。 1 component 構成なので固定名で十分。 */
const DEFAULT_COMPONENT_NAME = "main";

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
  readonly status?: string;
  readonly public_url?: string;
}

/**
 * credential を束ねた `SakuraAppRunClient` を返す factory。 deploy worker (composition root) が
 * `SakuraAppRunAdapterContext.client` としてこれを渡す。
 */
export function createSakuraAppRunRestClient(
  credential: SakuraCredential,
  options: SakuraAppRunRestClientOptions = {},
): SakuraAppRunClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  // Basic 認証: Access Token : Secret を base64。 ADR-026 D3 (静的 API key)。
  const authHeader = `Basic ${Buffer.from(`${credential.accessToken}:${credential.accessTokenSecret}`).toString("base64")}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sakura AppRun API ${method} ${path} failed: ${res.status} ${text}`.trim());
    }
    // No Content (delete) は body 無し。
    if (res.status === StatusCodes.NO_CONTENT) return undefined as T;
    return (await res.json()) as T;
  }

  /** name で application を 1 件解決 (= name↔id mapping)。 不在は undefined。 */
  async function findByName(name: string): Promise<SakuraApiApplication | undefined> {
    const listed = await request<{ data?: SakuraApiApplication[] }>("GET", "/applications");
    return (listed.data ?? []).find((app) => app.name === name);
  }

  /** spec → AppRun PostApplicationBody。 env(record) → [{key,value}]、 image → component。 */
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
        // 既存は id 指定で PUT 更新 (= 冪等 deploy)。
        await request("PUT", `/applications/${existing.id}`, body);
        return;
      }
      await request("POST", "/applications", body);
    },

    async getApplication(name: string): Promise<SakuraApplicationState | undefined> {
      const existing = await findByName(name);
      if (!existing) return undefined;
      // list の time-of-check と read の time-of-use の間に消えていれば不在扱い。
      const app = await request<SakuraApiApplication>("GET", `/applications/${existing.id}`);
      return {
        status: app.status ?? "unknown",
        ...(app.public_url ? { publicUrl: app.public_url } : {}),
      };
    },

    async deleteApplication(name: string): Promise<void> {
      const existing = await findByName(name);
      if (!existing) return; // idempotent
      await request("DELETE", `/applications/${existing.id}`);
    },
  };
}
