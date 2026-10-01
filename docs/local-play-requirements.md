# Local competition system requirements

This is an unpublished integration candidate. Use macOS or Linux (including
WSL2), the repository-pinned Bun version, and Docker Engine with Compose for
Docker exercises. Native Windows is not a supported entrypoint. See
[local hosting](local-hosting.md) for startup and trusted-network restrictions.

## Capacity is workload-dependent

The pinned catalog declares 106 Compose problems: 34 use one service, 67 use two,
3 use four and 2 use six. These are definitions, not measured concurrent process
counts; one-shot initialization services may exit. There are 154 published-port
entries across the complete catalog. Fifteen problems additionally need a terminal.

Twenty problems across four or five teams means 80 or 100 environments if every
problem is prepared for every team. The selected mix can define 80–216 services
for four teams or 100–270 for five. This does not establish a RAM requirement or
prove those environments can run concurrently on a given machine.

## Current allocation and admission limits

New Docker events prepare up to 512 dormant team/problem jobs per event. Participants
start or resume only the environments they need. Existing events retain their
legacy lifecycle. The defaults are:

- 3 active environments per team
- 12 active environments across the host
- 4096 MiB for the sum of configured container-memory caps of active environments
- 40 gateway slots for active environments, independent of the dormant job count

The memory check sums configured caps; it does not sample RAM or reserve host
memory. It can reject a start before either environment-count limit is reached.
New Compose plans preserve authored limits and fill missing values with 512 MiB
memory, 1 CPU and 256 PIDs per service. Old plans are left unchanged.

Override admission limits through the managed entrypoint after reviewing the workload:

```sh
make local LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096"
```

There is no automatic eviction or reset. Stop retains the existing writable layer,
volumes and dense runtime-port assignments, not RAM. After make down / make local,
new on-demand Docker jobs remain stopped until participants resume them.

A synthetic 20-problem × 5-team plan allocated 100 jobs and 105 runtime ports.
This proves allocation and lifecycle behavior only. It is not a 100-container
performance result, a real Docker benchmark or a recommended machine size.
Increasing admission limits does not establish capacity.

## What to measure before a larger event

- The exact source/catalog revisions, machine, Docker version and architecture
- Cold image build/pull and concurrent participant Start / resume
- Idle and active CPU, memory, storage, ports and Docker network usage
- Concurrent submissions, workbench requests and terminal sessions
- One failed environment, host restart, retained scores and ownership recovery
- Stop / resume writable-layer and volume retention, admission rejection and no automatic eviction
- State-preserving make down / make local, participant resume and explicit environment teardown

Generic catalog/workbench restoration is in progress. Full real Docker/browser
verification remains incomplete. Terminal HTTP/WebSocket tests use a synthetic
shell (11 tests, 96 assertions); actual Docker exec is unverified. Use the selected problem set's
recorded evidence rather than claiming all 106 are tested playable.

## Native compatibility

`asm-worst-case-latency` declares native amd64 with rdtscp, constant_tsc,
nonstop_tsc and clflush. A host that can only emulate it must fail closed.
A valid runtime requirement is not permission to alter machine security settings.

## Historical measurements

The [legacy measurements and profiles](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/docs/local-play-requirements.md)
refer to the old individual-practice runtime. They are historical observations,
not benchmarks of this candidate or evidence for a 20-problem competition.
