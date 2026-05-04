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
 */
export type AppMode = "dev-mock" | "backend";

export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly mode: AppMode;
}

interface RuntimeConfig {
  readonly apiBaseUrl?: string;
  readonly eventTitle?: string;
  readonly eventRegion?: string;
  readonly mode?: AppMode;
}

const DEV_FALLBACK: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (dev mock)",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!res.ok) {
      console.info("[config] no runtime-config.json (dev mode), using fallback");
      return DEV_FALLBACK;
    }
    const runtime = (await res.json()) as RuntimeConfig;
    return {
      apiBaseUrl: runtime.apiBaseUrl ?? DEV_FALLBACK.apiBaseUrl,
      eventTitle: runtime.eventTitle ?? DEV_FALLBACK.eventTitle,
      eventRegion: runtime.eventRegion ?? DEV_FALLBACK.eventRegion,
      mode: runtime.mode ?? DEV_FALLBACK.mode,
    };
  } catch {
    return DEV_FALLBACK;
  }
}
