<!-- Use a specific Conventional Commit title. Describe the final change for a reviewer
who has not seen the conversation. Scale detail to the change; omit irrelevant sections. -->

## Change

<!-- What problem does this solve, and what will work after merging? A short before/after
example is often enough. Keep the code needed for that behavior in the same PR.
Add `Closes #N` only for issues fully resolved by this change. -->

## Validation

<!-- Record actual commands, results, and the behavior they cover.
`make before-commit` is required before committing (the pre-commit hook runs it).
Include relevant type/build/synth checks and regression evidence for the changed paths.
Mark unrun checks explicitly. Real AWS/device/third-party checks can be optional event
rehearsals; they do not require keeping a development PR in Draft. -->

## Risks and recovery

<!-- Which existing behavior could change? For resource, data, auth, or cross-plane
contract changes, describe affected consumers, physical impact, and recovery steps.
Use a diagram or table when it helps the review. Omit this section if not applicable.
Deployment, releases, destructive actions, and shared-environment changes still require
explicit authorization; merging a PR is not an instruction to deploy it. -->
