/** One in-memory mutation intent. A lost response keeps its key; an acknowledged result ends it. */
export class PendingOperation {
  private pending?: { readonly scope: string; readonly body: string; readonly key: string };

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

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
