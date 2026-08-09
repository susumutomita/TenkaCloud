/** Parse one --flag=<exact-value> argument without accepting duplicates or blank values. */
export function addExactValueArgument(
  argument: string,
  allowedFlags: ReadonlySet<string>,
  values: Map<string, string>,
  unknownArgumentLabel = "unknown argument",
): void {
  const separator = argument.indexOf("=");
  const key = separator > 0 ? argument.slice(0, separator) : argument;
  if (!allowedFlags.has(key)) throw new Error(`${unknownArgumentLabel}: ${argument}`);
  if (separator < 1) throw new Error(`${key} requires =<exact-value>`);
  if (values.has(key)) throw new Error(`${key} was provided more than once`);
  const value = argument.slice(separator + 1).trim();
  if (!value) throw new Error(`${key} requires a non-empty exact value`);
  values.set(key, value);
}
