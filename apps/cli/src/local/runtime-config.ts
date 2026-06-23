/**
 * Issue #1975: participant-portal の runtime-config.json を local mode 用に生成する純関数。
 *
 * portal は `${BASE_URL}runtime-config.json` を読み、 `mode: "backend"` のとき apiBaseUrl を
 * 叩く。 local では apiBaseUrl が `http://127.0.0.1:<port>` (= loopback http)。 portal は #871 で
 * backend mode の非 HTTPS を弾くが、 loopback だけは許容するよう緩和済み (config.ts、 同 PR)。
 * cloudMode は "mock" (= 実 provider 実行はしない、 portal の mock 警告 UI 用)。
 */

export interface LocalRuntimeConfigInput {
  readonly apiBaseUrl: string;
  readonly eventTitle?: string;
}

export function generateLocalRuntimeConfig(input: LocalRuntimeConfigInput): string {
  const config = {
    apiBaseUrl: input.apiBaseUrl,
    eventTitle: input.eventTitle ?? "TenkaCloud Local (self-paced)",
    eventRegion: "local",
    mode: "backend",
    cloudMode: "mock",
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
