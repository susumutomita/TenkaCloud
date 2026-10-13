import type { ProbeFn } from "../lib/http-probe-client";
import { bunOrganizerPasswords } from "./bun-passwords";
import { HostingDomain } from "./hosting-domain";
import type { RuntimeEngine } from "./model";
import type { OrganizerPasswords } from "./organizer-passwords";
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
    passwords: OrganizerPasswords = bunOrganizerPasswords,
  ) {
    super(store, engine, masterKey, now, log, uptimeProbe, passwords);
  }
}
