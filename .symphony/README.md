# TenkaCloud Symphony fleet

<!-- textlint-disable -->

This directory is the development control plane for four independent repositories:

| ID | Repository | Workspace process |
| --- | --- | --- |
| `platform` | `susumutomita/TenkaCloud` | platform and generic integration work |
| `simulator` | `susumutomita/TenkaCloudSimulator` | generic Simulator capabilities |
| `challenge` | `susumutomita/TenkaCloudChallenge` | problems, learning content, and catalog contracts |
| `passport` | `susumutomita/TenkaCloudPassport` | the independent Passport application |

Symphony is not linked into the TenkaCloud runtime. It is a local engineering service that watches
GitHub Issues, creates one isolated workspace per Issue, and starts Codex in that workspace. One
Symphony process is used per repository because the GitHub Issues adapter is intentionally scoped to
one `owner/repo` value.

## Safety posture

OpenAI's Elixir implementation is prototype software. Run this fleet only on a trusted development
machine. Pin the Symphony binary or source checkout to a reviewed release or commit and verify its
published checksum before use.

The workflows enforce these boundaries:

- only open Issues carrying `agent:ready` are dispatchable;
- every repository has a separate process, port, log root, and workspace root;
- Codex is limited to `workspace-write`;
- the GitHub token is used by Symphony's host-side adapter and is not inherited by Codex;
- source pushes use the operator's Git SSH authentication;
- production deploy, destroy, release, force-push, secrets, and credentials are prohibited;
- the repository-local `make agent-gate` is the deterministic completion contract;
- a clean `codex exec review --base origin/main` review is required after the gate;
- low-risk work may squash merge only after all checks and review threads are clean;
- medium- and high-risk work stops for human review.

## Prerequisites

Install and authenticate the following on the host:

- a reviewed Symphony executable;
- Codex CLI, authenticated with `codex login`;
- Git and SSH access to all four repositories;
- a GitHub token with the minimum repository access needed to read/write Issues and pull requests and
  read checks.

Do not place the token in a workflow file. Export it in the host shell:

```bash
export GITHUB_TOKEN='...'
export SYMPHONY_BIN="$HOME/bin/symphony"
export SYMPHONY_WORKSPACE_ROOT="$HOME/code/tenkacloud-symphony/workspaces"
export SYMPHONY_LOGS_ROOT="$HOME/code/tenkacloud-symphony/logs"
```

`SYMPHONY_WORKSPACE_ROOT` and `SYMPHONY_LOGS_ROOT` must be absolute paths. The fleet launcher passes a
separate child workspace root to each process.

## GitHub labels

Create the `agent:ready` label in every repository before running the fleet. Applying it is the
explicit dispatch action. The workflow removes it when human input is required or retry limits are
exhausted.

Optional operational labels such as `agent:blocked`, `agent:human-review`, and `risk:low` may be
added later, but the initial protocol does not depend on them existing.

## Validate without credentials

The manifest and all four workflow contracts can be inspected without a GitHub token, Symphony, or
Codex installation:

```bash
make symphony-validate
make symphony-print
```

Select one or more repositories with `SYMPHONY_ARGS`:

```bash
make symphony-print SYMPHONY_ARGS="--repo simulator --repo challenge"
```

Validation checks:

- unique repository IDs, repositories, workflow paths, workspace names, and ports;
- GitHub tracker scope and open/closed states;
- the required `agent:ready` label;
- exact repository clone isolation;
- frozen dependency installation;
- `make agent-gate` and independent Codex review requirements;
- the destructive-action prohibition;
- Codex workspace sandbox and unattended approval policy.

## Run

After validation and prerequisite setup:

```bash
make symphony-run
```

Run only one repository while introducing the system:

```bash
make symphony-run SYMPHONY_ARGS="--repo platform"
```

Each child exposes its Symphony status surface on the port in `fleet.json`:

- platform: `4311`
- simulator: `4312`
- challenge: `4313`
- passport: `4314`

If one child exits, the launcher terminates and reaps the rest instead of leaving a partially running
fleet. Workspace contents persist so a subsequent run can resume the Issue; Symphony cleans the
workspace when the Issue reaches its terminal `closed` state.

## Repository-local gate contract

Every repository exposes:

```bash
make agent-gate
```

The control plane never guesses a repository's internal commands. Each repository owns and evolves
its own gate while retaining this stable entry point. Gate changes are high risk and require human
review.

## Cross-repository changes

Do not clone several repositories into one Issue workspace and do not treat four PRs as one atomic
merge. Use a parent Issue to state the dependency order and give every repository its own Issue,
branch, PR, gate, and rollback boundary.

Prefer backwards-compatible contract additions in this order:

1. add a generic capability to TenkaCloudSimulator;
2. add a problem requiring it to TenkaCloudChallenge;
3. update TenkaCloud compatibility integration or pins;
4. leave Passport unchanged unless the product requirement explicitly includes it.

<!-- textlint-enable -->
