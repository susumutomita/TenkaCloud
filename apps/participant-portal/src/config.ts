/**
 * Participant Portal の runtime config。
 *
 * production では CloudFront 同ドメインの `/runtime-config.json` に書かれる。
 * dev では fallback で固定値を使う (実 API 呼び出しはできない、UI 確認用)。
 *
 * `apiBaseUrl` は portal backend (Lambda Function URL) への base URL。
 * `eventTitle` は TopBar / Home に表示される現在のイベント名。
 * `mode` は backend 連携モード。`"dev-mock"` はフロント単体動作 (mock auth が有効)。
 *   `"backend"` は本物の backend API を呼ぶ。runtime-config の値が優先、なければ
 *   fallback で `"dev-mock"` 扱い。
 * `cloudMode` は実際に問題環境を作る provider execution mode。frontend はこれを見て
 * offline/mock/localstack の警告 UI を出すが、認証 skip には使わない。
 */
export type AppMode = "dev-mock" | "backend";
export type CloudMode = "real" | "mock" | "localstack";

export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly mode: AppMode;
  readonly cloudMode: CloudMode;
  readonly localstackEndpoint?: string;
}

interface RuntimeConfig {
  readonly apiBaseUrl?: string;
  readonly eventTitle?: string;
  readonly eventRegion?: string;
  readonly mode?: AppMode;
  readonly cloudMode?: CloudMode;
  readonly localstackEndpoint?: string;
}

const DEV_FALLBACK: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (dev mock)",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
  cloudMode: "mock",
};

/**
 * Issue #871: backend mode で apiBaseUrl が tampered で attacker URL を指すと、 portal が
 * teamLoginKey (= bearer) を attacker に送ってしまう。 backend mode のときは HTTPS を強制
 * (= dev-mock mode では localhost http を許容)。
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isCloudMode(value: unknown): value is CloudMode {
  return value === "real" || value === "mock" || value === "localstack";
}

function defaultCloudMode(mode: AppMode): CloudMode {
  return mode === "backend" ? "real" : "mock";
}

function normalizeLocalstackEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    const allowedHost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const allowedProtocol = url.protocol === "http:" || url.protocol === "https:";
    if (!allowedHost || !allowedProtocol) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    // GitHub Pages の sub-path 配信 (= `/TenkaCloud/portal-demo/` 等) でも 正しく
    // runtime-config.json を引けるよう、 Vite の `BASE_URL` (= build 時の `--base`) を
    // prefix にする。 root 配信 (= CloudFront) では `BASE_URL = "/"` なので従来通り
    // `/runtime-config.json` を引く。
    const res = await fetch(`${import.meta.env.BASE_URL}runtime-config.json`, {
      cache: "no-store",
    });
    if (!res.ok) {
      console.info("[config] no runtime-config.json (dev mode), using fallback");
      return DEV_FALLBACK;
    }
    const runtime = (await res.json()) as RuntimeConfig;
    const mode = runtime.mode ?? DEV_FALLBACK.mode;
    const cloudMode = isCloudMode(runtime.cloudMode) ? runtime.cloudMode : defaultCloudMode(mode);
    const apiBaseUrl = runtime.apiBaseUrl ?? DEV_FALLBACK.apiBaseUrl;
    // Issue #871: backend mode は HTTPS 必須 (= teamLoginKey を attacker に漏らさない)
    if (mode === "backend" && apiBaseUrl && !isHttpsUrl(apiBaseUrl)) {
      console.error("[config] runtime-config.json apiBaseUrl is not HTTPS in backend mode", {
        apiBaseUrl,
      });
      return DEV_FALLBACK;
    }
    return {
      apiBaseUrl,
      eventTitle: runtime.eventTitle ?? DEV_FALLBACK.eventTitle,
      eventRegion: runtime.eventRegion ?? DEV_FALLBACK.eventRegion,
      mode,
      cloudMode,
      localstackEndpoint:
        cloudMode === "localstack"
          ? normalizeLocalstackEndpoint(runtime.localstackEndpoint)
          : undefined,
    };
  } catch {
    return DEV_FALLBACK;
  }
}
