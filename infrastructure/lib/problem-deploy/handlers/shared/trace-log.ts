type TraceFields = Readonly<Record<string, unknown>>;

function cleanFields(fields: TraceFields): TraceFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function writeTrace(
  writer: (message?: unknown, ...optionalParams: unknown[]) => void,
  level: "info" | "warn" | "error",
  event: string,
  fields: TraceFields,
): void {
  writer(
    JSON.stringify({
      event,
      level,
      component: "problem-deploy",
      timestamp: new Date().toISOString(),
      ...cleanFields(fields),
    }),
  );
}

export function logDeployTrace(event: string, fields: TraceFields = {}): void {
  writeTrace(console.log, "info", event, fields);
}

export function warnDeployTrace(event: string, fields: TraceFields = {}): void {
  writeTrace(console.warn, "warn", event, fields);
}

export function errorDeployTrace(event: string, fields: TraceFields = {}): void {
  writeTrace(console.error, "error", event, fields);
}
