# Local mode system requirements

What local play costs depends on which components you run and how many problems
are up at the same time, so this page publishes three run profiles instead of one
"required memory" figure. Every number below is traced to a measurement record
under [`docs/measurements/local-mode/`](./measurements/local-mode/); numbers that
have not been measured are shown as **unverified** rather than estimated from a
typical machine.

Re-run any of it yourself with `make local-measure` (see
[Re-running the benchmark](#re-running-the-benchmark)).

## The three profiles

| Profile | Who it is for | Components | Problems at once | Status |
| --- | --- | --- | --- | --- |
| `minimum` | A participant solving a single drill | local-play API + Participant Portal (one `tenkacloud-local` container), SQLite state store, one lightweight single-container problem | 1 | Measured |
| `recommended` | Trying several drills, or authoring | the same control plane, plus terminal, scoring, hints and writeups in parallel | 3 (`DEFAULT_MAX_RUNNING`) | Partially measured |
| `full` | An organizer rehearsing a whole event locally | the recommended profile plus the TenkaCloud Simulator and composite problems (experimental), the event management UI (planned) and the AI agent runner with full prompt / tool-call / action history (planned) | 3 | Planned — not guaranteed |

The Simulator, the AI agent runner and the event management UI are **not** part of
the `minimum` or `recommended` profiles. The `full` profile is a target: parts of
it are not complete in local mode, so no resource figures are published for it at
all. Do not read the `recommended` numbers as covering it.

## Measured values

### macOS arm64 — record `2026-08-08-macos-arm64-colima`, release v1.1.0

Host: MacBook Air M5 / 32 GB, 10 logical CPUs. Docker via colima with its default
VM. **This machine is a worked example, not the basis of a minimum requirement.**
No smaller machine has been measured yet, so nothing here says a smaller one
fails.

| What | Value |
| --- | --- |
| Docker VM allocation | 4 CPUs / 3.81 GiB (colima default) |
| Docker Engine / Compose | 29.6.1 / 5.3.1 |
| Control plane alone | 1 container, 119 MiB |
| `minimum` profile (+ one lightweight problem) | 2 containers, 136 MiB |
| Two lightweight problems at once | 3 containers, 157 MiB |
| `tenkacloud-local:dev` image | 755 MB (3.71 GB at v1.0.0) |
| Build context transferred | 1.11 MB (1.02 GB at v1.0.0) |

The control plane dominates: 119 MiB of the 136 MiB `minimum` total. A lightweight
single-container problem adds 16-20 MiB, so for lightweight problems the
concurrency limit is not what makes memory tight.

**BuildKit cache is the failure mode to know about.** It is not counted in the
image size and is not reclaimed on its own. During the recorded run it grew to
58 GB, filled the Docker VM disk, and image export then failed with
`rpc error: EOF` — which reads as an unexplained build failure rather than as a
full disk. `docker builder prune -af` reclaims it.

### Other platforms

| Platform | Status |
| --- | --- |
| macOS arm64 | Measured (above) |
| macOS x86_64 | Unverified — no record yet |
| Linux x86_64 | Unverified — no record yet |
| WSL2 | Unverified — no record yet |
| Codespaces | Unverified — no record yet |

All five are supported for local play (see [README](../README.md)); only macOS
arm64 has a measurement behind it. Contributing a record for the others is a
single `make local-measure` run.

## Not measured yet

These apply to every profile and are why `recommended` is "partially measured":

- multi-container problems (`wp-exposed-backup` runs 4 services)
- three problems running at once, the `DEFAULT_MAX_RUNNING` default
- cold and warm start durations
- free disk needed for a first run (control-plane image + problem images + cache)
- 30-60 minutes of continuous use
- resource reclaim across repeated start / stop / reset
- the TenkaCloud Simulator

## Checking your own machine

```bash
make doctor PROFILE=recommended              # prerequisites + resource comparison
make doctor PROFILE=recommended PROBE_DISK=1 # also measure Docker VM free space
```

The resource comparison is advisory and never changes the exit code. It reports
one of three verdicts per item, and the difference between the last two is the
point:

- **PASS** — the value was read and is at or above a configuration this profile
  was measured in.
- **WARN** — the value was read and is below every measured configuration. That
  means untested, not too small; nothing has been shown to fail at that size.
- **UNKNOWN** — the value could not be read, or the profile has no measurement to
  compare against. Never upgraded to PASS: a machine whose Docker allocation
  cannot be queried has not been checked.

Each non-PASS item prints one concrete next command. Example:

```text
Selected profile: recommended — Recommended — several problems at once (partially-measured)
  ? Docker memory — 3.81 GiB available; no measurement recorded for the "recommended" profile yet
      Next: Measure it on this machine and contribute the record: `make local-measure PROFILE=<id>`
  ✓ Docker VM free disk — 40.54 GiB free; 755 MB is the tenkacloud-local:dev control-plane image only …
  Result: UNKNOWN — at least one value could not be read or has never been measured.
```

`PROBE_DISK=1` is opt-in because it is the one check that is not read-only: it
pulls `busybox` to read free space from inside the Docker VM. The host's own `df`
is the wrong filesystem on macOS and Windows, where images and build cache live in
a VM disk — the recorded disk-full failure happened while the host had tens of GB
free.

If the disk is short, reclaim only TenkaCloud-owned space:

```bash
docker builder prune -af   # the build cache, the usual culprit
docker image prune -af     # dangling images
make local-down            # stop local play and clear its progress volume
```

## Re-running the benchmark

`make local-measure` starts a profile's problems through the already-running
local-play API, samples only TenkaCloud-owned containers, stops them, asserts they
were reclaimed, and writes a JSON record.

```bash
make local                                                    # start local play first
make local-list                                               # find problem ids
make local-measure PROFILE=minimum PROBLEMS=sqli-demo PHASE=warm RELEASE=v1.1.0
```

| Variable | Meaning |
| --- | --- |
| `PROFILE` | `minimum` or `recommended` (`full` is refused while it is planned) |
| `PROBLEMS` | Comma-separated problem ids; the count must match the profile's concurrency |
| `PHASE` | `cold` (nothing cached) or `warm`; declared by you, not detected |
| `RELEASE` | The release the run is against, recorded in the file name |
| `HOST_DESCRIPTION` | Free text describing the machine |
| `OUT` | Output path (default `docs/measurements/local-mode/<recordId>.json`) |

Two measurement rules are enforced in code rather than left to discipline:

- Only `tenkacloud-local` and `tc-local-*` containers are counted, so unrelated
  containers on the measurer's machine cannot inflate a published number.
- Only the used side of `docker stats`' `MemUsage` is summed. The right-hand side
  is the VM limit, repeated identically on every row, and adding it up multiplies
  the VM size by the container count.

A run that leaves containers behind fails instead of publishing: an unreclaimed
container means the numbers are not a steady state.

CI validates the record **schema**, never the values
(`infrastructure/test/scripts/local-profile-records.test.ts`). Measured values
legitimately differ per host and per release; pinning them would pressure whoever
re-measures into rounding a real reading to keep CI quiet. What CI does guarantee
is that every published number resolves to a record file that contains it — a
figure with no record behind it fails the build.

## Related

- [README](../README.md) / [README.ja](../README.ja.md) — supported environments
- [docs/local-play.md](./local-play.md) — every local-play subcommand
- [`scripts/local/profiles.ts`](../scripts/local/profiles.ts) — the profile definitions this page renders
- [`scripts/local/measure-profile.ts`](../scripts/local/measure-profile.ts) — the benchmark
