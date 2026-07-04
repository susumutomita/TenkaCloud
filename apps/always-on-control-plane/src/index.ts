import { createApp } from "./app.js";
import { reconcileEvents } from "./reconcile.js";
import type { AppEnvironment } from "./types.js";

const app = createApp();

/**
 * Always-On mode entrypoint: the Hono app serves HTTP; the Cron trigger (wrangler
 * `triggers.crons`) drives control-plane reconciliation on Workers — no constant AWS tick.
 */
export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: AppEnvironment["Bindings"],
    _ctx: ExecutionContext,
  ): Promise<void> {
    const outcome = await reconcileEvents(env.CONTROL_DB, new Date());
    console.log(JSON.stringify({ event: "always-on.reconcile", ...outcome }));
  },
};
