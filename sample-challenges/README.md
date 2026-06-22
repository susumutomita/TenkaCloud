# Sample challenges (Issue #1973)

Free, no-AWS-account challenges where the participant publishes an app to an
external runtime (Cloudflare Temporary Account, a local container, or another
cloud) and TenkaCloud's external evaluator grades the live endpoint.

These directories hold **only participant-facing assets** — starter code, the
public API contract, deploy and agent instructions. The grading logic (hidden
test inputs, expected results) and the clear-code signing key live on the
TenkaCloud side in `@tenkacloud/endpoint-eval`, never here.

| Challenge                                                  | Summary                                  |
| ---------------------------------------------------------- | ---------------------------------------- |
| [`cloudflare-api-security-001`](./cloudflare-api-security-001/) | Harden a profile API stage by stage |

The evaluator that grades these runs locally (`bun run
packages/endpoint-eval/src/server.ts`) with no AWS, and the same engine deploys
to Lambda for the hosted free mode.
