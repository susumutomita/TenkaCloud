# TenkaCloud Symphony

This repository owns and runs its own Symphony instance. It does not start, configure, validate, or
monitor Symphony for TenkaCloudSimulator, TenkaCloudChallenge, or TenkaCloudPassport.

## Files

- `.symphony/WORKFLOW.md`: GitHub Issues tracker scope, workspace bootstrap, agent policy, review loop,
  and merge policy for `susumutomita/TenkaCloud` only.
- `Makefile` (Symphony section): repository-local `symphony-validate`, `symphony-print`, and
  `symphony-run` commands.

## Setup

Install a reviewed Symphony binary and Codex CLI on the host. Authenticate Codex and Git over SSH,
then export repository-local runtime values:

```bash
export GITHUB_TOKEN='...'
export SYMPHONY_WORKSPACE_ROOT="$HOME/code/tenkacloud/workspaces"
export SYMPHONY_BIN="$HOME/bin/symphony"
```

The GitHub token must have only the permissions needed for this repository. Symphony keeps tracker
authentication host-side and removes it from the Codex child environment.

## Validate

```bash
make symphony-validate
make symphony-print
```

Validation checks that the workflow is scoped to this repository, requires `agent:ready`, invokes the
repository's `make agent-gate`, requires independent Codex review, and preserves the destructive-action
boundary.

## Run

```bash
make symphony-run
```

The default status port is `4311`. Override `SYMPHONY_PORT`, `SYMPHONY_LOGS_ROOT`, or
`SYMPHONY_WORKFLOW` through Make variables when needed.

Other TenkaCloud repositories have their own independent `.symphony/WORKFLOW.md`, workspace root,
port, logs, token scope, quality gate, and lifecycle. Updating this repository must never be required
to start Symphony in another repository.
