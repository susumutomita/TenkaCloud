/**
 * Problem Management Service エントリポイント
 *
 * Hono + Bun で起動
 */

import { serve } from 'bun';
import { app } from './routes';

const port = parseInt(process.env.PORT || '3100');

console.log(`
╔══════════════════════════════════════════════════════════════╗
║         TenkaCloud Problem Management Service                ║
╠══════════════════════════════════════════════════════════════╣
║  Server starting...                                          ║
║                                                              ║
║  Endpoints:                                                  ║
║    - Admin API:  http://localhost:${port}/api/admin             ║
║    - Player API: http://localhost:${port}/api/player            ║
║    - Health:     http://localhost:${port}/health                ║
║                                                              ║
║  Environment:                                                ║
║    - NODE_ENV: ${process.env.NODE_ENV || 'development'}                             ║
║    - KEYCLOAK_URL: ${process.env.KEYCLOAK_URL || 'http://localhost:8080'}        ║
║    - KEYCLOAK_REALM: ${process.env.KEYCLOAK_REALM || 'tenkacloud'}                    ║
╚══════════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`🚀 Server is running on http://localhost:${port}`);
