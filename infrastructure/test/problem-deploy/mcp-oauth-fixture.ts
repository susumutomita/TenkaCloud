import type { McpOAuthConfig } from "../../lib/problem-deploy/mcp-oauth-config.js";

export function mcpConfigFixture(): McpOAuthConfig {
  const now = Math.floor(Date.now() / 1000);
  return {
    userPoolId: "us-east-1_TestPool",
    resourceUrl: "https://participant.example.test/mcp",
    callbackUrls: ["http://127.0.0.1:13337/callback"],
    bindings: [
      {
        subject: "00000000-0000-4000-8000-000000000001",
        tenantId: "local",
        eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B1",
        teamId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
        jobIds: ["01HZX0K3M3K9ZQHB3MRQHBA1B3"],
        notBefore: now - 60,
        expiresAt: now + 3600,
        allowSubmit: true,
      },
    ],
  };
}
