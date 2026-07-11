import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isLoopbackUrl } from "../local-play/loopback";

export type AppMode = "dev-mock" | "backend";
export type CloudMode = "real" | "mock" | "local";

export interface RuntimeConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly mode: AppMode;
  readonly cloudMode: CloudMode;
}

export interface RuntimeConfigOptions {
  readonly cloudMode: CloudMode;
  readonly portalMode?: AppMode;
  readonly apiBaseUrl?: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly out: string;
  readonly print: boolean;
}

interface MutableOptions {
  cloudMode?: CloudMode;
  portalMode?: AppMode;
  apiBaseUrl?: string;
  eventTitle: string;
  eventRegion: string;
  out: string;
  print: boolean;
}

const DEFAULT_OUT = "apps/participant-portal/public/runtime-config.json";

function usage(): string {
  return [
    "Usage: bun run scripts/participant-portal-runtime-config.ts --cloud-mode <mock|local|real> [options]",
    "",
    "Options:",
    "  --portal-mode <dev-mock|backend>       Participant Portal API mode",
    "  --api-base-url <url>                   Portal backend base URL",
    "  --event-title <title>                  Event title",
    "  --event-region <region>                Display region",
    "  --out <path>                           Output path",
    "  --print                                Print JSON instead of writing",
  ].join("\n");
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCloudMode(value: string): CloudMode {
  if (value === "real" || value === "mock" || value === "local") return value;
  throw new Error(`Invalid --cloud-mode: ${value}`);
}

function parseAppMode(value: string): AppMode {
  if (value === "dev-mock" || value === "backend") return value;
  throw new Error(`Invalid --portal-mode: ${value}`);
}

const VALUE_HANDLERS: Record<string, (state: MutableOptions, value: string) => void> = {
  "--cloud-mode": (state, value) => {
    state.cloudMode = parseCloudMode(value);
  },
  "--portal-mode": (state, value) => {
    state.portalMode = parseAppMode(value);
  },
  "--api-base-url": (state, value) => {
    state.apiBaseUrl = value.replace(/\/$/, "");
  },
  "--event-title": (state, value) => {
    state.eventTitle = value;
  },
  "--event-region": (state, value) => {
    state.eventRegion = value;
  },
  "--out": (state, value) => {
    state.out = value;
  },
};

function parseArgs(argv: readonly string[]): RuntimeConfigOptions {
  const state: MutableOptions = {
    eventTitle: "TenkaCloud Battle (offline)",
    eventRegion: "ap-northeast-1",
    out: DEFAULT_OUT,
    print: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--print") {
      state.print = true;
      continue;
    }
    const handler = VALUE_HANDLERS[arg];
    if (!handler) throw new Error(`Unknown argument: ${arg}`);
    handler(state, requireValue(argv, i, arg));
    i++;
  }

  const cloudMode = state.cloudMode;
  if (!cloudMode) throw new Error("--cloud-mode is required");
  return {
    cloudMode,
    portalMode: state.portalMode,
    apiBaseUrl: state.apiBaseUrl,
    eventTitle: state.eventTitle,
    eventRegion: state.eventRegion,
    out: state.out,
    print: state.print,
  };
}

function defaultPortalMode(cloudMode: CloudMode): AppMode {
  return cloudMode === "real" ? "backend" : "dev-mock";
}

/**
 * Issue #871: backend mode requires HTTPS so a tampered apiBaseUrl cannot exfil
 * the teamLoginKey to an attacker host. Issue #1975/#2054: local mode wires the
 * portal to the loopback scoring API (`http://127.0.0.1:<port>`), which never
 * leaves the machine, so loopback HTTP is the one allowed exception.
 */
function normalizeApiBaseUrl(value: string, cloudMode: CloudMode): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error(`Invalid --api-base-url: ${value}`, { cause: err });
  }
  const loopbackHttp = url.protocol === "http:" && isLoopbackUrl(value);
  if (url.protocol !== "https:" && !(cloudMode === "local" && loopbackHttp)) {
    throw new Error("--api-base-url must be HTTPS when participant portal runs in backend mode");
  }
  return url.toString().replace(/\/$/, "");
}

export function buildRuntimeConfig(options: RuntimeConfigOptions): RuntimeConfig {
  const mode = options.portalMode ?? defaultPortalMode(options.cloudMode);
  if (mode === "backend" && (!options.apiBaseUrl || options.apiBaseUrl.trim().length === 0)) {
    throw new Error("--api-base-url is required when participant portal runs in backend mode");
  }
  const apiBaseUrl =
    mode === "backend"
      ? normalizeApiBaseUrl(options.apiBaseUrl ?? "", options.cloudMode)
      : (options.apiBaseUrl ?? "http://localhost:3199/dev-mock");
  return {
    apiBaseUrl,
    eventTitle: options.eventTitle,
    eventRegion: options.eventRegion,
    mode,
    cloudMode: options.cloudMode,
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const json = `${JSON.stringify(buildRuntimeConfig(options), null, 2)}\n`;
    if (options.print) {
      process.stdout.write(json);
      return;
    }
    const out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json, "utf8");
    console.log(`Wrote ${out}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
