import type { HostingApi } from "../lib/hosting-api";
import type { TerminalTransportService } from "./terminal-http";

/** Local HTTP application port. Authentication and runtime/state implementations stay behind it. */
export interface HostingHttpApplication extends HostingApi {
  readonly now: () => number;
  readonly engine: { readonly hasAws?: boolean };
  readonly accountConnection?: { readonly region: string };
  readonly store: { localOrganizerKeyEnabled(): boolean };
  readonly saml: {
    metadata(): string;
    consume(response: string, relayState: string): Promise<string>;
    bindOrigin(origin: string): void;
  };
  readonly terminals: TerminalTransportService;
}
