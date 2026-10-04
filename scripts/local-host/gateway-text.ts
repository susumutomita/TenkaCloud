import { mapStrings } from "./container/port-remap";

/** Rewrite only origins explicitly exposed by this job; verifier and internal URLs are not gateways. */
export function gatewayText<T>(value: T, origins: ReadonlyMap<string, string>): T {
  return mapStrings(value, (text) =>
    text.replace(
      /http:\/\/(?:127\.0\.0\.1|localhost):\d+/gu,
      (origin) => origins.get(origin) ?? origin,
    ),
  );
}
