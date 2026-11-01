import type { HostingApi } from "../lib/hosting-api";
import type { TerminalTransportService } from "./terminal-http";

/** Local HTTP application port. Authentication and runtime/state implementations stay behind it. */
export interface HostingHttpApplication extends HostingApi {
  readonly now: () => number;
  readonly accountConnection?: { readonly region: string };
  readonly terminals: TerminalTransportService;
}
