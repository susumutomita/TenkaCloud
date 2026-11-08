/** Bound cancellation even after response headers arrive and a body read is pending. */
export async function consumeSimulatorStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  consume: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const reader = body.getReader();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Consume cancellation even if the signal fires between two pending chunk consumers.
  void aborted.catch(() => {
    /* The active read race reports the cancellation. */
  });
  const abort = () => rejectAbort(new Error("Simulator stream cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      // Promise.race also observes a read rejection that arrives after cancellation.
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      signal.throwIfAborted();
      await consume(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    // Do not let a nonsettling underlying cancel callback prevent timeout cleanup.
    void reader.cancel().catch(() => {
      /* Preserve the original stream failure. */
    });
    try {
      reader.releaseLock();
    } catch {
      /* Preserve the original stream failure. */
    }
  }
}
