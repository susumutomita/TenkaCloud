import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type AppMode = "dev-mock" | "backend";
type CloudMode = "real" | "mock" | "localstack";

interface RuntimeConfig {
  readonly apiBaseUrl: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly mode: AppMode;
  readonly cloudMode: CloudMode;
  readonly localstackEndpoint?: string;
}

interface Options {
  readonly cloudMode: CloudMode;
  readonly portalMode?: AppMode;
  readonly apiBaseUrl?: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  readonly localstackEndpoint?: string;
  readonly out: string;
  readonly print: boolean;
}

interface MutableOptions {
  cloudMode?: CloudMode;
  portalMode?: AppMode;
  apiBaseUrl?: string;
  eventTitle: string;
  eventRegion: string;
  localstackEndpoint?: string;
  out: string;
  print: boolean;
}

const DEFAULT_OUT = "apps/participant-portal/public/runtime-config.json";

function usage(): string {
  return [
    "Usage: bun run scripts/participant-portal-runtime-config.ts --cloud-mode <mock|localstack|real> [options]",
    "",
    "Options:",
    "  --portal-mode <dev-mock|backend>       Participant Portal API mode",
    "  --api-base-url <url>                   Portal backend base URL",
    "  --event-title <title>                  Event title",
    "  --event-region <region>                Display region",
    "  --localstack-endpoint <url>             LocalStack endpoint (localstack mode)",
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
  if (value === "real" || value === "mock" || value === "localstack") return value;
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
  "--localstack-endpoint": (state, value) => {
    state.localstackEndpoint = value.replace(/\/$/, "");
  },
  "--out": (state, value) => {
    state.out = value;
  },
};

function parseArgs(argv: readonly string[]): Options {
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
    localstackEndpoint: state.localstackEndpoint,
    out: state.out,
    print: state.print,
  };
}

function defaultPortalMode(cloudMode: CloudMode): AppMode {
  return cloudMode === "real" ? "backend" : "dev-mock";
}

function normalizeLocalstackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error(`Invalid LocalStack endpoint URL: ${value}`, { cause: err });
  }
  const allowedHost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowedProtocol = url.protocol === "http:" || url.protocol === "https:";
  if (!allowedHost || !allowedProtocol) {
    throw new Error(
      `LocalStack endpoint must be http(s) localhost/127.0.0.1/[::1], got ${url.origin}`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error(`Invalid --api-base-url: ${value}`, { cause: err });
  }
  if (url.protocol !== "https:") {
    throw new Error("--api-base-url must be HTTPS when participant portal runs in backend mode");
  }
  return url.toString().replace(/\/$/, "");
}

function buildRuntimeConfig(options: Options): RuntimeConfig {
  const mode = options.portalMode ?? defaultPortalMode(options.cloudMode);
  if (mode === "backend" && (!options.apiBaseUrl || options.apiBaseUrl.trim().length === 0)) {
    throw new Error("--api-base-url is required when participant portal runs in backend mode");
  }
  const apiBaseUrl =
    mode === "backend"
      ? normalizeApiBaseUrl(options.apiBaseUrl ?? "")
      : (options.apiBaseUrl ?? "http://localhost:3199/dev-mock");
  return {
    apiBaseUrl,
    eventTitle: options.eventTitle,
    eventRegion: options.eventRegion,
    mode,
    cloudMode: options.cloudMode,
    ...(options.cloudMode === "localstack"
      ? {
          localstackEndpoint: normalizeLocalstackEndpoint(
            options.localstackEndpoint ?? "http://localhost:4566",
          ),
        }
      : {}),
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

main();
