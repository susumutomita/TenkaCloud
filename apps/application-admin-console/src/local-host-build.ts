/**
 * Issue #3226: true only in the local competition host build. `vite.host.config.ts` replaces
 * the private `__TENKACLOUD_LOCAL_HOST_BUILD__` constant at build time. It is deliberately not a
 * `VITE_*` variable, so an exported environment variable can never switch a cloud or demo build
 * into local-host mode.
 */
declare const __TENKACLOUD_LOCAL_HOST_BUILD__: boolean | undefined;

export const LOCAL_HOST_BUILD =
  typeof __TENKACLOUD_LOCAL_HOST_BUILD__ !== "undefined" &&
  __TENKACLOUD_LOCAL_HOST_BUILD__ === true;
