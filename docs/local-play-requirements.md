# Local competition system requirements

Use macOS or Linux (including
WSL2), the repository-pinned Bun version, and Docker Engine with Compose for
Docker exercises. Native Windows is not a supported entrypoint. See
[local hosting](local-hosting.md) for startup and trusted-network restrictions.

## Capacity is workload-dependent

Plan from the selected problem definitions and runtime requirements, not a fixed
machine-size table. The [Compose adapter](../scripts/local-host/docker-catalog.ts)
reads the authored services, ports and capabilities. Dormant job allocation does not
prove those environments can run concurrently.

## Allocation and admission responsibilities

[On-demand jobs](../scripts/local-host/on-demand-containers.ts) own job admission;
[container budgets](../scripts/local-host/container-budget.ts) own active environment
and configured-memory checks; [runtime ports](../scripts/local-host/runtime-ports.ts)
own port allocation. Defaults and supported overrides are in
[entrypoint help](../scripts/local-host/main.ts). These checks sum declared caps;
they do not sample RAM or reserve operating-system resources.

There is no automatic eviction or reset. Stop retains writable layers, volumes and
runtime-port assignments, not RAM. After shutdown and restart, participants resume
on-demand environments explicitly. Increasing admission limits does not establish
capacity. See [local hosting](local-hosting.md#capacity) for benchmark commands.

## What to measure before a larger event

- The exact source/catalog revisions, machine, Docker version and architecture
- Cold image build/pull and concurrent participant Start / resume
- Idle and active CPU, memory, storage, ports and Docker network usage
- Concurrent submissions, workbench requests and terminal sessions
- One failed environment, host restart, retained scores and ownership recovery
- Stop / resume writable-layer and volume retention, admission rejection and no automatic eviction
- State-preserving make down / make local, participant resume and explicit environment teardown

Full real Docker/browser verification remains incomplete. In addition to synthetic
terminal HTTP/WebSocket checks, a real PostgreSQL terminal was used to create data
and complete three scored checkpoints. Its container and seven rows survived
make down, restart and resume; a second team could not access it. This verifies
that representative terminal, not every terminal implementation. Use the selected problem set's
recorded evidence rather than claiming the complete catalog is tested playable.

## Native compatibility

`asm-worst-case-latency` declares native amd64 with rdtscp, constant_tsc,
nonstop_tsc and clflush. A host that can only emulate it must fail closed.
A valid runtime requirement is not permission to alter machine security settings.

## Historical measurements

The [legacy measurements and profiles](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/docs/local-play-requirements.md)
refer to the old individual-practice runtime. They are historical observations,
not benchmarks of the current host or evidence for a 20-problem competition.
