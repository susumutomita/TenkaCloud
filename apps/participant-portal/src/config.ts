/**
 * Participant Portal の runtime config。
 *
 * production では CloudFront 同ドメインの `/runtime-config.json` に書かれる。
 * dev では fallback で固定値を使う (実 API 呼び出しはできない、UI 確認用)。
 *
 * `apiBaseUrl` は portal backend (Lambda Function URL) への base URL。
 * `eventTitle` は TopBar / Home に表示される現在のイベント名。
 */
export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
}

interface RuntimeConfig {
  readonly apiBaseUrl?: string;
  readonly eventTitle?: string;
  readonly eventRegion?: string;
}

const DEV_FALLBACK: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (dev mock)",
  eventRegion: "ap-northeast-1",
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!res.ok) {
      // dev では runtime-config.json は存在しないので fallback を返す
      console.info("[config] no runtime-config.json (dev mode), using fallback");
      return DEV_FALLBACK;
    }
    const runtime = (await res.json()) as RuntimeConfig;
    return {
      apiBaseUrl: runtime.apiBaseUrl ?? DEV_FALLBACK.apiBaseUrl,
      eventTitle: runtime.eventTitle ?? DEV_FALLBACK.eventTitle,
      eventRegion: runtime.eventRegion ?? DEV_FALLBACK.eventRegion,
    };
  } catch {
    return DEV_FALLBACK;
  }
}
