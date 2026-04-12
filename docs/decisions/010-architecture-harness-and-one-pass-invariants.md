# ADR-010: アーキテクチャ原則をハーネス化し one-pass を完了条件にする

- **Status**: Accepted
- **Date**: 2026-04-12
- **Deciders**: susumutomita

## Context

TenkaCloud は Control Plane / Application Plane / competitor AWS account の責務分離が仕様上は決まっている一方で、セッションごとの認識ずれや一時しのぎ実装により、完了条件が「画面が出る」「一部 API が通る」に崩れやすかった。

この状態では、`tenant 作成 -> provisioning -> tenant runtime 到達 -> problem deploy -> participant 競技開始` の一気通貫が最後まで閉じず、ローカルと AWS の双方でワンパスが成立しない。

また、`Codex` と `Claude Code` を併用する以上、口頭ルールだけでは維持できない。repo 内の正本と Git hook で強制する必要がある。

## Decision

1. 原則の正本を [`docs/architecture/harness.md`](../architecture/harness.md) に置く
2. 次を invariant として ID 付きで固定する
   - `INVARIANT_SERVERLESS_ONLY`
   - `INVARIANT_TENANT_IS_COMPANY`
   - `INVARIANT_DEPARTMENT_IS_NOT_TENANT`
   - `INVARIANT_ONE_APPLICATION_PLANE_PER_TENANT`
   - `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`
   - `INVARIANT_PROBLEM_RUNTIME_IN_COMPETITOR_AWS_ACCOUNTS`
   - `ONE_PASS_LOCAL`
   - `ONE_PASS_AWS`
3. `scripts/architecture-harness.ts` を追加し、正本ドキュメントと staged 変更を検査する
4. `packages/shared/src/quality/architecture-harness.ts` に検出ロジックを置き、テストで固定する
5. `.husky/pre-commit` で `bun scripts/architecture-harness.ts --staged --fail-on=error` を必須化する
6. `AGENTS.md`, `CLAUDE.md`, `docs/CONTRIBUTING.md` はこのハーネスを参照し、agent 固有ルールではなく repo ルールを優先する

## Consequences

- **Good**: セッションが変わっても原則の所在が揺れない。Control Plane への problem deploy 持ち込みや serverful runtime 逆戻りをコミット前に落とせる。
- **Bad**: 文書更新や設計変更のたびにハーネスの更新が必要になる。
- **Tradeoff**: 開発の自由度は少し下がるが、完成条件と責務境界は大きく安定する。

## References

- [docs/architecture/harness.md](../architecture/harness.md)
- [docs/architecture/architecture.md](../architecture/architecture.md)
- [AGENTS.md](../../AGENTS.md)
- [CLAUDE.md](../../CLAUDE.md)
