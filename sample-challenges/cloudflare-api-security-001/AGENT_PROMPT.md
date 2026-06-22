# Agent prompt example

Paste a prompt like this into Claude Code (or another coding agent) to drive the
challenge end to end. The agent writes and hardens the Worker; it never sees the
hidden tests or the clear-code key.

```text
You are solving the TenkaCloud "API Security Deploy Challenge".

Working dir: sample-challenges/cloudflare-api-security-001
Contract: see README.md (fixture users alice/bob, /healthz, /profiles/:id).

Goal: pass stages 0 -> 4 from the external evaluator.

Loop:
1. Implement or fix src/index.ts.
2. Deploy: `bunx wrangler deploy --temporary` and capture the workers.dev URL.
3. Create a run, then POST the URL to the evaluator for the current stage.
4. If it fails, read the safe failure summary, fix the specific weakness, redeploy.
5. Stop when stage 4 passes and you have its clear code.

Constraints:
- Do not hardcode fixed responses; test inputs change per run.
- Never leak stack traces, internal errors, or secret token values.
- Keep normal functionality working while adding each defense.
```
