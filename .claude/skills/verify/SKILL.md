---
name: verify
description: Verify TenkaCloud changes after implementation. Use before commit or PR, and after fixing a failed check. Run every check available in the current environment, repair code-caused failures, and report unavailable environment checks as UNVERIFIED instead of stopping.
---

# TenkaCloud verification

1. Read the Issue or request, its Acceptance Criteria, `AGENTS.md`, and `git diff` before deciding what to verify.
2. Separate checks into three states:
   - `VERIFIABLE`: runnable with the repository and tools available in the current environment.
   - `UNVERIFIED`: requires unavailable infrastructure, credentials, a shared AWS environment, an external service/account, a physical device, or other capability not present in the current session.
   - `FAILED`: a check was runnable and failed for a reason attributable to the implementation or repository state.
3. Run the narrowest relevant tests first. For a code-caused failure, inspect the failure, fix the implementation, and rerun the failed check. Repeat until it passes or a genuine blocker unrelated to missing external environment is identified.
4. Once the focused checks are green, run `make before-commit`. For broad or high-risk changes, also run `make ci-local` when its prerequisites are available in the current environment.
5. Do not weaken tests, type checks, lint, coverage, security checks, or configuration merely to make a gate green. Do not replace unavailable validation with a mock, empty value, silent fallback, or claimed success.
6. An unavailable external or physical environment is not a reason to stop implementation, commit preparation, or PR preparation. Record that check as `UNVERIFIED`, state exactly why it could not run, and state the smallest human or disposable-environment check that remains.
7. Never claim an `UNVERIFIED` item passed. If an Acceptance Criterion can only be observed in such an environment, distinguish source/CI evidence from the remaining runtime evidence.
8. Destructive operations, releases, shared-environment changes, production deployment, and secret access still require explicit human approval; verification must not perform them automatically.

## Report

Return a concise verification report with:

- `VERIFIED`: commands/checks that passed and what they establish.
- `UNVERIFIED`: unavailable checks, the missing capability, and the exact remaining check.
- `FAILED`: only runnable checks that still fail, with the evidence and likely cause.
- Acceptance Criteria mapping: which criteria are supported by which evidence.

Do not mark the task blocked merely because `UNVERIFIED` is non-empty.