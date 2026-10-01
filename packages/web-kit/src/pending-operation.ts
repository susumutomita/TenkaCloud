/** Non-authentication receipt identifier; getRandomValues also works in opt-in HTTP LAN hosting.
 * https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues
 */
export function newOperationKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** One in-memory mutation intent. A lost response keeps its key; an acknowledged result ends it. */
export class PendingOperation {
  private pending?: { readonly scope: string; readonly body: string; readonly key: string };

  constructor(private readonly newKey: () => string = newOperationKey) {}

  keyFor(scope: string, payload: unknown): string {
    const body = JSON.stringify(payload);
    if (typeof body !== "string") throw new Error("Operation payload must be JSON serializable.");
    if (this.pending?.scope !== scope || this.pending.body !== body)
      this.pending = { scope, body, key: this.newKey() };
    return this.pending.key;
  }

  acknowledge(key: string): void {
    // A late result from a previous environment must not reset a newer intent.
    if (this.pending?.key === key) this.pending = undefined;
  }
}
