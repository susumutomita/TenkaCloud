import type { AppConfig } from "../config";

interface LocalHostRuntimeConfig {
  readonly mode?: string;
  readonly role?: string;
  readonly apiBaseUrl?: string;
  readonly hasAws?: boolean;
}

export function localCompetitionConfig(runtime: LocalHostRuntimeConfig, origin: string): AppConfig {
  const expected = `${origin}/api`;
  if (
    runtime.mode !== "local-host" ||
    runtime.role !== "participant" ||
    runtime.apiBaseUrl !== expected
  )
    throw new Error(
      "Invalid competition configuration. No demo or automatic-login fallback is permitted.",
    );
  // Local hosting uses the competition portal and its normal team-key login.
  // Learning tracks belong to the self-paced/explicit learning entry points.
  return {
    apiBaseUrl: expected,
    coordinationApiUrl: expected,
    eventTitle: "TenkaCloud Local Competition",
    eventRegion: "local",
    mode: "backend",
    cloudMode: "real",
    hasAws: runtime.hasAws === true,
  };
}
