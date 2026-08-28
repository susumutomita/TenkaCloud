# ADR-0003: local-play runtime の Docker trust boundary

- **Status**: Accepted target architecture; implementation is phased
- **Date**: 2026-08-28
- **Deciders**: Susumu Tomita (`@susumutomita`)
- **Tracked by**: [Issue #3097](https://github.com/susumutomita/TenkaCloud/issues/3097)

## Context

Docker-only local play は、control-plane container に active Docker context の raw daemon socket と
`network_mode: host` を与え、catalog の Compose を `up`、`down`、`exec` する。現在の
`compose.local.yaml` が記載するとおり、raw Docker socket は root-equivalent host access です。
control plane を non-root にしても、socket 経由で privileged container や host bind mount を作成できる
限り、host isolation の最終境界にはならない。

`scripts/local-play/manifest.ts` は problem metadata の wiring を検証するが、Compose の security
policy は検証しない。`scripts/local-play/port-remap.ts` は loopback publish port だけを書き換え、
volume、capability、namespace、device 等を保持する。したがって malicious または compromised な
Compose が catalog に入った場合、local play 自身が fail closed にする seam は現在存在しない。

外部 problem pack、CTFd integration、problem marketplace へ進むには、「catalog を取得できる」ことと
「host access を許可する」ことを分離する必要がある。

## Decision

### 1. Bounded security claim

最終構成で主張する保証を次に限定する。

> Local-play problem は、review 済み allowlist に含まれる runtime operation と Compose feature だけを
> 使える。problem content、image、Compose、`runtime.entry` が malicious でも、raw Docker API、
> catalog directory 外の host path、host namespace、device、dangerous capability へ直接到達できない。

container image 自身の kernel exploit、Docker daemon / runtime の脆弱性、participant が host 上で
直接実行した任意 command までは保証しない。専用 rootless daemon は blast RADIUS を縮小するが、
container escape 不在の証明ではない。

### 2. Trust classification

| Asset | Trust level | Rule |
| --- | --- | --- |
| TenkaCloud platform source / runtime broker | trusted computing base | signed/reviewed release から実行する |
| pinned core catalog metadata | trusted for identity and expected policy profile | pin と review は必要だが、host permission の根拠にはしない |
| problem Compose / Dockerfile / build context | untrusted input | canonicalize 後に policy validation する |
| external problem pack | untrusted input | signatureだけでは許可せず、同じ policy を適用する |
| problem container image | untrusted workload | broker-managed namespace と resource limit 内だけで実行する |
| participant submission / terminal command | untrusted workload input | terminal allowlist と problem container 内に限定する |
| host Docker daemon / socket | privileged infrastructure | control plane へ渡さない |
| Docker credential store / cloud credential / SSH agent | secret | broker と problem の mount/env から除外する |

core catalog を trusted source と呼ぶ場合でも、その意味は「problem id、metadata schema、expected
policy profile を review した」に限定する。任意の Compose directive を host 上で許可したという意味には
しない。

### 3. Target architecture: policy-enforcing Local Runtime Broker

control plane から raw Docker socket を削除し、host-side の **Local Runtime Broker** だけが Docker
daemon に接続する。broker は Docker API の透過 proxy ではなく、次の domain operation だけを公開する。

- `startProblem(problemId, generation, portBlock)`
- `stopProblem(runtimeId)`
- `getProblemStatus(runtimeId)`
- `getBoundedLogs(runtimeId, service)`
- `execTerminal(runtimeId, declaredService, commandProfile)`
- `reconcileOwnedRuntimes(sessionId)`

```text
Participant Portal / local control plane
  -> authenticated local broker protocol
      -> policy + path containment
          -> dedicated Docker context
              -> managed problem containers
```

broker API に任意 image、volume、Docker endpoint、Compose path、raw command array を渡す field は設けない。
`problemId` から pinned catalog entry を broker 自身が再解決し、control plane が送った path を信用しない。

control plane と broker の protocol は local UNIX socket を第一候補とし、Windows portability が必要な
環境では loopback-only TCP と per-セッション random bearer を使う。socket/token は 1 セッションごとに生成し、
repository、log、browser response に出さない。

### 4. Docker daemon boundary

優先順位は次のとおりとする。

1. local play 専用の rootless Docker context / daemon。
2. Docker Desktop / Colima の専用 VM 内 context。
3. native rootful daemon 上の broker-managed namespace。

3 は portability fallback であり、同じ Compose policy を必須にする。rootful daemon fallback 時は
「broker compromise が daemon 権限へ到達し得る」という residual risk を起動時に明示する。raw socket を
control plane に戻す fallback は設けない。

### 5. Compose canonicalization and policy

validation 対象は raw YAML text ではなく、固定 version の Compose implementation が生成した canonical
model とする。broker は `docker compose config --format json` 相当の parse/interpolation を隔離された
preflight で実行し、その JSON model を schema + policy validator に渡す。parse warning、unknown field、
interpolation failure は fail closed とする。

#### Allowed by default

| Feature | Constraint |
| --- | --- |
| `image` | digest pin または approved registry / tag policy を満たす |
| `build.context` | problem directory 配下の real path。ただし `runtimes/<family>/` (`<problemsRoot>/runtimes/`) は、TenkaCloudChallenge AGENTS.md §13 が定義する複数 problem 共有 runtime の唯一の例外として許可する (Phase A 実装: `scripts/local-play/compose-policy.ts#catalogRuntimesRoot`)。volume source には同じ例外を認めない — build context だけの例外である |
| `build.dockerfile` | build context 配下の regular file |
| environment | metadata の declared variable と generated problem secret だけ |
| `ports` | host IP は `127.0.0.1`、assigned port block 内、TCP のみ |
| internal networks | broker が生成する project network のみ |
| named volumes | broker が project scope で命名・所有する volume のみ |
| healthcheck | bounded interval / timeout / retries、shell injection を含まない approved form |
| dependency ordering | `depends_on` の service-local relation |
| resource limits | policy floor/ceiling 内の CPU、memory、PID |
| terminal service | metadata が 1 つ明示し、running service と一致する |

#### Denied by default

- `privileged: true`。
- host bind mount。read-only でも default deny とし、platform-owned fixture を例外 registry で明示する。
- Docker、containerd、Podman、CRI 等の runtime socket。
- `/proc`、`/sys`、`/dev`、host home、repository root、credential directory の mount。
- `devices`、`device_cgroup_rules`。
- `pid: host`、`ipc: host`、`network_mode: host`、service/container namespace join。
- `cap_add`。例外 capability は global allowlist ではなく problem-specific reviewed profile で与える。
- `security_opt` による seccomp/AppArmor/SELinux 無効化、`no-new-privileges:false`。
- arbitrary `userns_mode`、cgroup namespace、sysctl、ulimit の緩和。
- host port の `0.0.0.0` / `::` publish、assigned block 外 publish、UDP publish。
- external network / external volume、fixed `container_name`、host-パス `env_file` / `secrets` / `configs`。
- catalog directory 外の build context、Dockerfile、volume source、`extends`、include。
- lifecycle hook、entrypoint、command から host-side executable を参照する構成。

unknown feature は permissive に無視せず denied とする。Compose version 更新時は canonical schema の差分と
dangerous fixture suite を review してから validator version を上げる。

### 6. Path and symlink containment

policy validator は lexical prefix ではなく real path で containment を判定する。

1. catalog root と problem directory を `realpath` する。
2. `runtime.entry`、Compose path、build context、Dockerfile、許可例外の file source を problem directory
   基準で解決する。absolute path と `..` traversal を拒否する。
3. path component ごとの symlink を解決した最終 real path が problem directory 自身またはその配下で
   あることを確認する。
4. missing path、broken symlink、FIFO/socket/device、case-folding 後の escape を拒否する。
5. validation 後の TOCTOU を減らすため、broker は content digest と file identity を記録し、build/start
   直前に再確認する。

`runtime.entry` は regular file または approved directory manifest だけを許可する。symlink 自体を一律
禁止するのではなく、解決先 containment と immutable digest を必須にする。

### 7. Network architecture

control plane の `network_mode: host` は最終構成で削除する。broker はセッションごとに managed bridge
network を作成し、problem service をその network に接続する。

- scoring / readiness は container DNS 名と internal port を使う。
- Participant-facing endpoint だけを host の `127.0.0.1:<assigned-port>` に publish する。
- control plane は broker の status/readiness operation を呼び、host loopback の sibling publish へ直接
  接続しない。
- problem 間通信は default deny。multi-service problem 内だけ project network を共有する。
- IPv6 publish を追加する場合も loopback `::1` を明示し、wildcard publish を許可しない。

これにより Docker Desktop の host-networking toggle 依存を外せる。broker protocol が loopback TCP
fallback を使う場合も、participant endpoint と別 port/token にし、LAN bind を禁止する。

### 8. Terminal exec policy

terminal は arbitrary `docker exec` proxy にしない。metadata が宣言した service と command profile に
限定し、次を broker が強制する。

- service は runtime ownership ledger に属する running container である。
- shell profile は approved executable と working directory を持つ。
- host path、Docker socket、broker socket を mount した service では terminal を許可しない。
- セッション duration、output bytes、process count を bound する。
- control-plane request から `--privileged`、`--user root`、namespace option を注入できない。

### 9. Ownership and cleanup

全 resource に broker セッション id、runtime id、problem digest の label を付ける。reconciliation は label と
ledger の積集合だけを対象にし、name prefix だけで foreign container を削除しない。broker crash 後は
新 broker が ledger + labels を照合し、ambiguous resource を自動削除せず operator に報告する。

### 10. Phased migration

| Phase | Change | Security claim / residual risk |
| --- | --- | --- |
| A (implemented) | `scripts/local-play/compose-policy.ts` を `container-runner.ts`（`start`/`recover`）と `manifest.ts`（`runtime.entry` containment）の前に実装。raw YAML の構造 parse + deny-by-default allowlist（現行 catalog 97 problem 全件を fixture として固定、`compose-policy.test.ts`） | malicious Compose の既知 dangerous feature（本文書 §5 の denied 表）は fail closed。§5 が記述する `docker compose config --format json` ベースの canonical model 検証は broker 導入後の Phase B に持ち越し — Phase A は Docker daemon 無しで動く raw-YAML validator であり、`tenkacloud local list` を Docker 依存にしない設計判断による。control plane compromise は raw socket に到達可能なまま |
| B | Local Runtime Broker を導入し、control plane から socket mount を削除 | problem/control-plane から raw Docker API を削除。broker compromise の daemon risk は残る |
| C | managed bridge network と internal readiness を導入し、`network_mode: host` を削除 | control plane の host network exposure と Docker Desktop toggle 依存を削除 |
| D | dedicated rootless context を default にする | broker compromise の host/rootful daemon blast RADIUS を縮小 |

Issue #3096 の non-root control plane は Phase A と並行する defense-in-depth であり、Phase B の代替ではない。

### 11. Portability requirements

- **Docker Desktop**: host-networking toggle を要求しない。broker helper の配布形式と socket transport を
  macOS / Windows で検証する。
- **Colima**: VM 内の daemon path と host-side proxy path を混同しない。dedicated profile/context を作る
  場合は既存 VM を破壊しない。
- **native Linux**: rootless context を推奨し、cgroup v2、subuid/subgid、systemd user service 不在時の
  guidance を用意する。
- **rootless Docker**: active context の UNIX socket と user namespace を broker が使用し、rootful
  `/var/run/docker.sock` へ暗黙 fallback しない。
- **Codespaces / docker-in-docker**: dedicated daemon が既に隔離 boundary 内にある場合も Compose policy を
  省略しない。

### 12. Security conformance suite

Phase A の merge gate として、少なくとも次の dangerous fixtures が fail closed になる test を追加する。

| Fixture | Expected rejection |
| --- | --- |
| `privileged-true` | privileged denied |
| `docker-socket-bind` | runtime socket / host bind denied |
| `host-root-bind` | problem directory 外 source denied |
| `device-pass-through` | devices denied |
| `cap-sys-admin` | cap_add denied |
| `host-pid-ipc-network` | host namespace denied |
| `unconfined-security-profile` | security profile relaxation denied |
| `wildcard-publish` | non-loopback publish denied |
| `external-network-volume` | externally owned resource denied |
| `build-context-escape` | real-パス containment denied |
| `runtime-entry-dotdot` | lexical traversal denied |
| `runtime-entry-symlink-escape` | symlink real-パス escape denied |
| `unknown-compose-feature` | unknown field denied |

positive fixtures は single-service、multi-service + one-shot initializer、named volume、healthcheck、
loopback publish を含める。test は validator error code まで固定し、単に「例外が出た」だけを合格にしない。

## Rejected alternatives

### Raw Docker socket + non-root だけ

socket API が container create/mount/exec を許すため、uid 1000 でも host-equivalent operation が可能で
ある。defense-in-depth として採用するが最終境界にはしない。

### Generic docker-socket-proxy

HTTP method/パス allowlist だけでは、合法な container-create request の body に privileged、host mount、
capability を埋め込める。TenkaCloud domain operation と canonical policy を理解する broker が必要です。

### Catalog signature だけ

signature は publisher identity と改ざん検出を与えるが、安全な Compose であることを保証しない。
trusted publisher の credential compromise にも対応できない。policy validation は省略しない。

### Host networking を先に削除

raw Docker socket が残る間は control plane が自分で host-network container を作成できるため、境界改善が
限定的です。policy、broker、network の順に移行します。

## Consequences

- **Good**: external problem distribution を進めても、problem content の trust と host permission を分離
  できる。
- **Good**: Docker Desktop host-networking setting に依存しない participant UX へ移行できる。
- **Bad**: broker binary/service、protocol、version negotiation、rootless context setup の運用対象が増える。
- **Bad**: 一部の既存 Compose problem は denied feature を使っていないか棚卸しが必要になる。
- **Tradeoff**: Phase A 完了後も raw socket は一時的に残るため、control plane compromise の residual
  risk を解消したとは表現しない。Phase B が claim の分岐点である。

## References

- Issue #3097
- Issue #3096 (non-root control plane)
- `compose.local.yaml`
- `scripts/local-play/docker-adapter.ts`
- `scripts/local-play/manifest.ts`
- `scripts/local-play/port-remap.ts`
- `scripts/local-play/catalog-loader.ts`
- `scripts/local-play/compose-policy.ts` (Phase A validator)
- `scripts/local-play/compose-policy.test.ts` (Phase A security regression suite)
- `scripts/local-play/container-runner.ts` (Phase A wiring: `start` / `recover`)
