const cleanups = new Set<() => void>();

/** Ctrl+C never reaches the `finally` blocks of pending awaits, so owners register here too. */
export function onInterrupt(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function exitOnInterrupt(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const cleanup of cleanups) cleanup();
      process.exit(130);
    });
  }
}
