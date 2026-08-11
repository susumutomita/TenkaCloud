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
 * offline/mock/local の警告 UI を出すが、認証 skip には使わない。
 */
export type AppMode = "dev-mock" | "backend";
export type CloudMode = "real" | "mock" | "local";

/**
 * 講座トラック (週・章順の自習経路) を出すモードか。
 *
 * Issue #2786 では「track 未設定なら空状態を出すだけ」という理由で常時表示にしていたが、
 * それは空かどうかの話で、誰に向けた画面かの話ではなかった。LP から辿れる公開デモは
 * `cloudMode === "mock"` で動くため、AC26 を受講していない人が最初に触る画面に講座前提の
 * 学習経路が並んでいた。
 *
 * 出すのは `local` — `make local` の単独ドリル、つまり自習している人の環境だけ。実イベント
 * (`real`) を含めないのは、そこで解く問題は主催者が選んで出すものであり、受講者ごとの
 * 学習経路とは別物だから。
 *
 * nav と route の両方がこれを見る。link を隠すだけでは URL が生きたままになり、共有された
 * `/course-tracks` を踏めば同じ画面に着く。
 */
export function showsCourseTracks(cloudMode: CloudMode): boolean {
  return cloudMode === "local";
}

export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly mode: AppMode;
  readonly cloudMode: CloudMode;
  /** Random local-session login key, present only in generated local runtime config. */
  readonly localTeamLoginKey?: string;
  /**
   * Issue #1420: team credential を使って参加者間 coordination dispatcher を呼び出す
   * 専用 Lambda の Function URL。coordination が無効な場合や旧 deploy で未配線の場合は undefined。
   * portal slot は coordination-client 経由で呼び出す。
   */
  readonly coordinationApiUrl?: string;
}

interface RuntimeConfig {
  readonly apiBaseUrl?: string;
  readonly eventTitle?: string;
  readonly eventRegion?: string;
  readonly mode?: AppMode;
  readonly cloudMode?: CloudMode;
  readonly localTeamLoginKey?: string;
  readonly coordinationApiUrl?: string;
}

const DEV_FALLBACK: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle Demo",
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

/**
 * Issue #1975: local self-paced mode は backend を `http://127.0.0.1:<port>` (loopback) で
 * 立てる。 #871 の HTTPS 強制は teamLoginKey を attacker URL に漏らさないためだが、 loopback
 * は同一マシン内で外部に出ないため bearer 漏洩経路にならない。 よって backend mode でも
 * loopback http だけは例外的に許容する (localhost / 127.0.0.1 / [::1])。
 */
function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function isCloudMode(value: unknown): value is CloudMode {
  return value === "real" || value === "mock" || value === "local";
}

function defaultCloudMode(mode: AppMode): CloudMode {
  return mode === "backend" ? "real" : "mock";
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
      // Issue #1247: 旧来は console.info の silent fallback だった (= production 配信
      // で runtime-config.json を S3/CloudFront 配備し忘れたとき、 dev-mock に倒れて
      // 「動くように見える」 misconfig 事故が起きた)。 fetch 自体が失敗 (= 404 / 5xx)
      // した時点で、 ブラウザの DevTools にも残るよう console.error に格上げ。 fallback
      // は dev 体験のため依然 DEV_FALLBACK を返すが、 operator が気付けるシグナルは出す。
      console.error("[config] runtime-config.json not reachable", {
        url: `${import.meta.env.BASE_URL}runtime-config.json`,
        status: res.status,
        statusText: res.statusText,
        fallback: DEV_FALLBACK.mode,
      });
      return DEV_FALLBACK;
    }
    const runtime = (await res.json()) as RuntimeConfig;
    const mode = runtime.mode ?? DEV_FALLBACK.mode;
    const cloudMode = isCloudMode(runtime.cloudMode) ? runtime.cloudMode : defaultCloudMode(mode);
    const apiBaseUrl = runtime.apiBaseUrl ?? DEV_FALLBACK.apiBaseUrl;
    // Issue #871: backend mode は HTTPS 必須 (= teamLoginKey を attacker に漏らさない)。
    // Issue #1975: ただし loopback http (= local self-paced mode の `http://127.0.0.1:<port>`) は
    // 同一マシン内で外部に出ず bearer 漏洩経路にならないため例外的に許容する。
    if (
      mode === "backend" &&
      apiBaseUrl &&
      !isHttpsUrl(apiBaseUrl) &&
      !isLoopbackHttpUrl(apiBaseUrl)
    ) {
      console.error("[config] runtime-config.json apiBaseUrl is not HTTPS in backend mode", {
        apiBaseUrl,
      });
      return DEV_FALLBACK;
    }
    // #1420: coordination dispatcher URL も backend mode では HTTPS 必須 (= teamLoginKey 漏洩防止)。
    // 非 HTTPS なら coordination だけ無効化し (= undefined)、 portal 本体は通常起動させる。
    const coordinationApiUrl =
      runtime.coordinationApiUrl && (mode !== "backend" || isHttpsUrl(runtime.coordinationApiUrl))
        ? runtime.coordinationApiUrl
        : undefined;
    return {
      apiBaseUrl,
      eventTitle: runtime.eventTitle ?? DEV_FALLBACK.eventTitle,
      eventRegion: runtime.eventRegion ?? DEV_FALLBACK.eventRegion,
      mode,
      cloudMode,
      ...(cloudMode === "local" && runtime.localTeamLoginKey
        ? { localTeamLoginKey: runtime.localTeamLoginKey }
        : {}),
      ...(coordinationApiUrl ? { coordinationApiUrl } : {}),
    };
  } catch {
    return DEV_FALLBACK;
  }
}
