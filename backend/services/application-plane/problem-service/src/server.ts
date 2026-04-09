/**
 * Problem Management Service エントリポイント
 *
 * Hono + Bun で起動
 */

import { serve } from "bun";
import { app } from "./routes";

const port = parseInt(process.env.PORT || "3100");

console.log(`
╔══════════════════════════════════════════════════════════════╗
║         TenkaCloud Problem Management Service                ║
╠══════════════════════════════════════════════════════════════╣
║  Server starting...                                          ║
║                                                              ║
║  Endpoints:                                                  ║
║    - Admin API:       http://localhost:${port}/api/admin        ║
║    - Player API:      http://localhost:${port}/api/player       ║
║    - Participant API: http://localhost:${port}/api/participant  ║
║    - Health:          http://localhost:${port}/health           ║
║    - API Docs (UI):   http://localhost:${port}/docs             ║
║    - OpenAPI JSON:    http://localhost:${port}/openapi.json     ║
║                                                              ║
║  Environment:                                                ║
║    - NODE_ENV: ${process.env.NODE_ENV || "development"}                             ║
║    - AUTH_SKIP: ${process.env.AUTH_SKIP || "0"}                                      ║
╚══════════════════════════════════════════════════════════════╝
`);

serve({
	fetch: app.fetch,
	port,
});

console.log(`🚀 Server is running on http://localhost:${port}`);
