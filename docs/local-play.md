# Local play (Docker, no AWS)

Local play lets a participant solve a problem entirely on their machine — no AWS
account, no cloud resources. Each problem ships as a **Docker container** that
owns both the challenge surface and its own scoring (`/verify`). TenkaCloud
contributes only the scoring half: the participant API, portal, leaderboard,
hints, and progress. (Issue #2054 — supersedes the earlier Kumo / AWS-emulator
approach.)

## How it works

```
make local [PROBLEM=<id>]
  ├─ local scoring API    scripts/local-play (reuses the portal contract)
  │     • a flag submission is forwarded to the container's /verify
  │     • the verdict is recorded (score / leaderboard / hints / score events)
  │     • PROBLEM=<id> pre-starts a container; otherwise containers start on demand
  ├─ Docker Compose up    the selected problem container (loopback only)
  │     • per-deploy random secret (FLAG_SEED, …) injected as env
  │     • the container serves the challenge surface AND POST /verify
  ├─ runtime-config.json   points the portal at the local API
  └─ participant portal    Vite dev server (cloudMode:"local")
make local-up → scoring API only (advanced / scripts)
make local-portal → attach the portal to an already-running local API
make local-down → Docker Compose down + restore runtime-config
```

| Layer                       | Owns     | Responsibility                                                        |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| Problem container (catalog) | problem  | The challenge itself **and `/verify`** (answer, hidden tests, scoring conditions live only here) |
| TenkaCloud platform         | platform | Scoring, portal, leaderboard, hints, orchestration (**no evaluation logic**) |

The platform never holds the answer. It delegates each submission to the
container and trusts the container's `correct` verdict. This is the local
counterpart of the cloud self-deploy model (a problem deploys its own verify
Lambda) — one `/verify` contract, two runtimes.

## Run it

```bash
make local                        # start the scoring API + browser portal; containers start on demand
make local PROBLEM=sqli-demo      # also pre-start that problem container, then open the portal
make local-list                   # print every playable problem id
make local-status                 # is local play running?
make local-evaluate FLAG='TC{…}'  # submit a flag from the CLI
make local-down                   # stop everything and restore runtime-config
```

Without `PROBLEM=`, `make local` pre-starts no problem containers. It starts the
loopback scoring API and browser portal so you can deploy/start a problem from
the portal screen. Use `PROBLEM=<id>` when you want the CLI to
pre-start one or more containers before the portal opens. Log in with any
non-empty team key. The challenge endpoints are shown on the problem page;
attack them, recover the flag, and submit it.

> Requires Docker Compose. Both `docker compose` and standalone `docker-compose`
> are supported. The scoring API port defaults to
> `3199` and can be overridden with `LOCAL_API_PORT`. If it is already taken,
> `make local` fails loudly rather than adopting a foreign server.
> For API-only automation, use `make local-up`; attach the browser later with
> `make local-portal`.

## The `/verify` contract

The problem container exposes `POST /verify` on a loopback admin port:

```jsonc
// request
{ "submission": "<string>", "context": { "teamId": "local", "problemId": "<id>" } }
// response
{ "correct": true, "points": 200, "message": "Flag accepted." }
```

- `points` is optional; the platform falls back to the manifest's `scoring.points`.
- `message` must be safe — it must **not** leak the answer or any hidden test on
  a wrong submission.

The platform's `POST /portal/me/submit-flag` forwards the submission verbatim and
reflects `correct` into the score. If `/verify` is unreachable or returns an
invalid verdict, the submission fails loudly (HTTP 502) — it is never silently
marked right or wrong.

### Multi-checkpoint problems (`scoring.kind: multi-verify`, #2252)

A container Challenge can score several independent checkpoints with partial
points. `metadata.json` declares them (points are the platform's single source
of truth — the container's `points` override is ignored for multi-verify). The
worked reference is [`wp-exposed-backup`](https://github.com/susumutomita/TenkaCloudChallenge/tree/main/challenges/wp-exposed-backup)
(4 checkpoints); a minimal copy-pasteable shape:

```jsonc
"scoring": {
  "kind": "multi-verify",
  "checks": [
    { "id": "public-backup", "label": "公開バックアップ", "points": 50,
      "wrongAnswerPenalty": 5,
      "hints": [{ "id": "h-backup", "content": "公開パスを確認する", "penalty": 2 }] },
    { "id": "exposed-config", "label": "設定ファイルの控え", "points": 50,
      "wrongAnswerPenalty": 5 }
  ]
}
```

- `checks` has 2–8 entries (4–6 recommended). Each `checks[].id` matches
  `^[a-z0-9][a-z0-9-]{0,63}$` and is unique; hint ids must be unique across the
  whole problem (the portal reveal route is keyed on `hintId`).
- `checks[].label` is ≤80 chars; `wrongAnswerPenalty` (if set) is ≤ that
  check's `points`. Points are positive integers and their sum is the problem
  total. These structural rules are enforced identically by the platform SDK
  parser, the local-play manifest loader, and the catalog validator.
- `checks[].label` / `hints` are competitor-facing: never spoil the
  vulnerability class in them. Translate them via `i18n.en.checks[]`
  (`id` + `label` + `hints` — never repeat points/ids in the overlay).
- The verify exchange adds `checkpointId`, and the container **must echo it**:

```jsonc
// request
{ "checkpointId": "public-backup", "submission": "<string>", "context": { ... } }
// response
{ "checkpointId": "public-backup", "correct": true, "message": "..." }
```

A missing/mismatched echo, or a `checkpointId` that is not declared in
`metadata.json`, fails closed — it is never forwarded, scored, or attributed to
another checkpoint. Scoring is idempotent per `(problemId, checkpointId)`: a
solved checkpoint is never re-awarded or re-penalized, and the problem counts
as completed on the leaderboard only when every checkpoint is solved. The
portal renders checkpoints through the existing multi-flag panel (one
submission box per checkpoint, per-checkpoint hints).

## Authoring a container problem

One directory = one problem. Problems live **only** in the
[TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
catalog (the `problems/` submodule) — never in this platform repo (ADR-008 /
ADR-012). The platform is problem-agnostic: `make local PROBLEM=<id>` resolves
`<id>` under `problems/challenges` or `problems/battles` when you choose to
pre-start a container from the CLI. Otherwise the portal deploys selected
problems on demand. The reference container problem is `sqli-demo` in the
catalog.

```
<problem>/
├── metadata.json            # the local manifest + scoring
└── local/
    ├── docker-compose.yml   # bind every port to 127.0.0.1 only
    ├── Dockerfile
    └── app/…                # challenge surface + /verify; answer lives only here
```

The manifest's `runtime` (container delivery, ADR-023) + `scoring` sections wire
the harness (no answer, no scoring conditions):

```jsonc
{
  "scoring": { "kind": "verify", "points": 200, "wrongAnswerPenalty": 10, "hints": [ … ] },
  "runtime": {
    "provider": "docker",
    "engine": "compose",
    "entry": "local/docker-compose.yml",
    "challengeEndpoints": { "Web": "http://127.0.0.1:18080" },
    "verifyUrl": "http://127.0.0.1:18081/verify",
    "secretEnv": ["FLAG_SEED"]
  }
}
```

- `scoring.kind` must be `"verify"` (the platform delegates instead of comparing)
  and `runtime.engine` must be `"compose"`.
- Every URL must be loopback (`localhost` / `127.0.0.1` / `[::1]`); the loader
  refuses anything else.
- Each name in `secretEnv` is filled with a fresh 256-bit secret per deploy and
  injected into the container as an env var. Derive the flag and any privileged
  credential from it so each run is unique and nothing secret is committed.

## Security

- Containers are loopback-only. Bind ports as `127.0.0.1:<host>:<container>` —
  `/verify` included.
- A container that fetches an external URL (cloud-style self-deploy) must apply
  SSRF defenses itself: a protocol and host allowlist, no redirect following, a
  timeout, and a response body cap.
- The portal stays HTTPS-only in backend mode; loopback HTTP is the one
  exception, because it never leaves the machine (#871 / #1975).

## Enterprise / internal training

Local play also works for closed-network company trainings and internal drills. If
you are considering TenkaCloud for enterprise or internal training use, please feel
free to reach out via the
[contact form](https://forms.gle/djVprYmq3hFgJA7P9) or
[GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions) — we
would love to learn about real-world training needs and custom exercise requirements.
