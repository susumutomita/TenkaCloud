import type { ProbeFn } from "../lib/http-probe-client";
import { HostingDomain } from "./hosting-domain";
import type { RuntimeEngine } from "./model";
import type { HostStore } from "./store";

export type { ApiRequest, ApiResponse } from "../lib/hosting-api";

/** Local composition facade preserves existing callers; domain has no default concrete provider. */
export class HostingService extends HostingDomain {
  constructor(
    store: HostStore,
    engine: RuntimeEngine,
    masterKey: string,
    now: () => number = Date.now,
    log: (message: string) => void = console.error,
    uptimeProbe?: ProbeFn,
  ) {
    super(store, engine, masterKey, now, log, uptimeProbe);
  }
}
