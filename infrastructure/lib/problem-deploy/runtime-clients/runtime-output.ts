/**
 * Convert provider-native deployment output values into the string-only shape persisted by
 * TenkaCloud control-data and consumed by scoring/UI.
 *
 * Primitive values remain human-readable. Structured values use deterministic JSON serialization.
 * Values that JSON cannot represent fail loudly instead of being silently persisted as an empty or
 * provider-specific placeholder.
 */
export function stringifyRuntimeOutput(value: unknown, source: string): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to the provider-labelled error below.
  }

  throw new Error(`${source} returned an output that is not JSON serializable`);
}
