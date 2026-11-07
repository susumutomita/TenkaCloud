# Opt-in original Hello World simulator rehearsal

Run this separately from the required unit suite. It is an integration command,
not a skipped CI test. Missing prerequisites or a failed assertion exit nonzero.
Nothing is installed or downloaded by this command. It does not use real AWS,
a browser, or Docker exercises, and does not demonstrate Hello World Battle.

## Prerequisites

- Bun **1.4.4**, `make`, and Bash on a POSIX host.
- Dependencies already installed from this checkout's frozen lockfile.
- Both local-host interfaces already built from this checkout with
  `bun run build:host --acceptance-provenance`. This produces `.tenkacloud/host-build` and the matching
  immutable catalog manifest; the ordinary applications’ `dist` builds alone
  are not sufficient. The strict provenance check is opt-in; ordinary builds
  retain their supported source layouts and do not create acceptance evidence.
  The strict rehearsal requires ordinary source/artifact files and directories,
  not symlinked source trees or build artifacts. Installed dependency workspace
  links under node_modules are permitted and only read.
- An explicitly supplied executable TenkaCloud Simulator binary supporting native
  STS/IAM/CloudFormation/SSM, operator token files and deployment events. The
  native source tree used for the rehearsal is published in
  [Simulator PR #442](https://github.com/susumutomita/TenkaCloudSimulator/pull/442),
  commit `f6c05a68bf87ddf62411235ae2111e0fcb5559c5`. The publication commit has
  the same source tree as the rehearsed local build; its commit metadata differs.
- An explicitly supplied official AWS CLI **1.46.3** executable. Other versions
  are rejected by this narrowly pinned rehearsal. Python/boto3 is not required
  separately by the test (the installed CLI has its own runtime).
- The original local Challenge source has already been acquired/prepared through
  the supported catalog workflow. This test requires the selected immutable
  snapshot `6eccbc93ded675743ed12267a547b39978de14a7af0075cc99674592b097c177`
  from original Challenge commit `c1aaaa967031ad2bcfa78feda0ae00f1ea87b67e`.
  The Hello World template hash must be
  `ad8b4fcf3f1d42475c5c2e8617d3194536810cc044a6ea166a2699cac719c8bb`.
  A same-name replacement problem is not accepted. The selected source must be a
  local directory that still matches the snapshot. Remote-selected catalogs are
  rejected: acquire a local copy explicitly before using this test.

The original problem source and the user's selected catalog and runtime data
must remain unchanged. The fixture prepares a private runtime copy, preserves
selected source identity, and invokes the normal `make local` path there. All
simulator state, host databases, synthetic keys and generated configuration live
in a private temporary directory removed on success or failure. SIGINT/Ctrl+C
and SIGTERM await bounded cleanup of owned process groups before returning a
nonzero interruption status. Forced SIGKILL cannot run cleanup handlers.

## Run

Unset proxies only for this test process; the host intentionally rejects ambient
proxies, even with `NO_PROXY`. Other shells and their proxy configuration remain
unchanged. Supply existing executable paths, not credentials:

```sh
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
  -u ALL_PROXY -u all_proxy \
  bun run test:simulator-hello \
  --simulator-binary /absolute/path/to/tenkacloud-simulator \
  --aws-cli /absolute/path/to/aws
```

The fixture starts the supplied Simulator on a private numeric loopback endpoint,
then launches actual `make local` subprocesses with explicit simulator endpoint,
region, private token file and least-privilege bootstrap. No AWS credential
provider chain or real endpoint is used. The organizer key is obtained through
the existing authenticated local reset control and held only in memory.

The command verifies organizer login, account verification, original deployment,
participant temporary credentials, the production copied shell setup and exact
original `aws ssm get-parameter --name ... --query Parameter.Value --output text`
command, private parameter scope, wrong/correct answers, score events and
leaderboard, native deployment log chronology, persistent score after a graceful
CLI restart, and teardown. A missing copied endpoint must fail closed.

Success prints a small JSON summary containing hashes and assertions, never
credentials or the answer. Failure withholds private subprocess output. This is
HTTP/CLI evidence, not GUI evidence. Logs are chronological within each native
provider page; this does not claim globally ascending multi-page history. The
optional rehearsal does not replace the required repository quality gate.
