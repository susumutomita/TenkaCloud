const cleanups = new Set<() => void | Promise<void>>();

/** Owners close their children before deleting disposable files, including on Ctrl+C. */
export function onInterrupt(cleanup: () => void | Promise<void>): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function exitOnInterrupt(): void {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void Promise.allSettled([...cleanups].map(async (cleanup) => cleanup())).then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        for (const failure of failures) console.error("Benchmark cleanup failed:", failure.reason);
        const interruptedCode = signal === "SIGINT" ? 130 : 143;
        process.exit(failures.length ? 1 : interruptedCode);
      });
    });
  }
}
