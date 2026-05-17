// runtime-config.json (= CloudFront 配下) で waitlist Google Form URL を注入する。
// dev では vite env (VITE_WAITLIST_FORM_URL) も fallback として参照する。
export interface AppConfig {
  /**
   * Google Form の埋め込み用 embed URL。
   * `https://docs.google.com/forms/d/e/<formId>/viewform?embedded=true`
   * 未設定なら waitlist セクションは「準備中」表示になる。
   */
  waitlistFormUrl: string | null;
  /** Participant Portal の URL (= 既にコンテストに招待されている人の入口) */
  participantPortalUrl: string | null;
  /** System Admin Console の URL (= 主催者 sign-in) */
  adminConsoleUrl: string | null;
  /** GitHub repo URL (= OSS としての CTA) */
  githubRepoUrl: string;
}

const DEFAULT_GITHUB_REPO_URL = "https://github.com/susumutomita/TenkaCloud";

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/runtime-config.json", { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as Partial<AppConfig>;
      return {
        waitlistFormUrl: json.waitlistFormUrl ?? readEnvWaitlistUrl(),
        participantPortalUrl: json.participantPortalUrl ?? null,
        adminConsoleUrl: json.adminConsoleUrl ?? null,
        githubRepoUrl: json.githubRepoUrl ?? DEFAULT_GITHUB_REPO_URL,
      };
    }
  } catch {
    // runtime-config.json が無い (= dev) ときは env fallback
  }
  return {
    waitlistFormUrl: readEnvWaitlistUrl(),
    participantPortalUrl: null,
    adminConsoleUrl: null,
    githubRepoUrl: DEFAULT_GITHUB_REPO_URL,
  };
}

function readEnvWaitlistUrl(): string | null {
  const url = import.meta.env.VITE_WAITLIST_FORM_URL;
  return typeof url === "string" && url.length > 0 ? url : null;
}
