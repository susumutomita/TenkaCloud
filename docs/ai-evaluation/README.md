# AI evaluation

Issue 2936。AI 機能を、後付けのテストではなく release infrastructure として評価するための方法と契約。

このページは **Phase 1 (contract / methodology) の成果物**です。共通契約と、それが機械で守られる範囲を書く。offline runner、scorer、judge、dashboard、shadow / canary は子 Issue で実装する。

## なぜ必要か

AI 機能は code が build と test を通っていても、model 更新、prompt 変更、Skill 差し替え、tool schema、context 圧縮、timeout 設定で静かに劣化する。従来の CI は「code が壊れたか」しか見ておらず、「振る舞いが劣化したか」を見ていない。

TenkaCloud には、この評価を強く作れる材料がある。問題ごとの決定論的 scoring、Simulator と local mode、agent の操作履歴、cloud state、policy decision を同じ run に相関できる。したがって最終回答の文章だけでなく、**実際に環境を正しく直したか、禁止操作をしていないか、主張に実行証拠があるか**まで採点できる。

## 5 つの原則と、それが機械で守られている場所

| 原則 | 機械で守っている場所 |
| --- | --- |
| 決定論的な証拠を LLM judge より先に採点する | `decideRelease` は safety violation を metric より先に読み、違反があればそこで返す |
| 完全一致を主評価にしない | dataset の coverage matrix が `normal_success` 以外の 11 区分を必須にする |
| 校正されていない judge を release gate に使わない | `judgeCalibrated` が false の run は `undecidable`。pass に丸めない |
| 安全性の hard failure を平均点で相殺しない | safety violation は 1 件で `blocked`。全 metric が baseline より良くても変わらない |
| 評価データと本番データの境界を守る | `assertNoSensitiveMaterial` が credential / 個人情報を検出して dataset を拒否する |

## 評価対象の version

model 名だけでは足りない。`EvaluationTarget` は次を **すべて必須**にする。1 つでも欠けた target は評価結果を名乗れない。

feature / version / provider / model / model snapshot / parameters / system prompt digest / instruction bundle digest / Skill digests / tool policy version / runtime version / dataset version / evaluator version / release gate policy version / baseline version。

同じ model でも prompt、Skill、tool policy、runtime、context の組み立てが変われば別 version とする。`assertVersionIntegrity` は「同じ version 番号で中身が違う 2 つの target」を検出して throw する。これを見逃すと「baseline と比較した」という主張そのものが嘘になる。

prompt と instruction は **digest だけ**を保存する。本文を保存すると、評価基盤が prompt の流出面になる。

## Golden dataset

自動 release gate を名乗る suite は、validated golden case を **最低 100 件**持つ。開発用の小さな smoke suite は許可するが、100 件未満の run に release 判断を載せることはできない。

件数だけでは意味がないので、coverage matrix の充足を同時に要求する。`evaluateDatasetReadiness` は、同じ template の言い換えを 200 件並べた dataset を **不合格**にする。

必須区分は次の 12 個。

normal success / ambiguous request / tool error / partial failure recovery / stale or conflicting evidence / prompt injection / forbidden or destructive request / budget limit / language variation / fairness pair / explanation-state mismatch / cost-quality tradeoff。

各 case は input、environment fixture digest、expected outcomes、forbidden effects、required evidence、rubric、severity、provenance を持つ。judge の calibration set は release gate dataset と分離する。

## 評価レイヤー

- **Layer 0 決定論的 outcome** — task 完了、最終 cloud / Simulator state、禁止副作用、policy decision、timeout / retry / crash、idempotency、cleanup、token / cost / latency。
- **Layer 1 factuality / grounding** — TenkaCloud における citation は URL に限らない。tool call ID、provider request ID、resource state snapshot、score event、health probe、policy decision へ主張を結びつける。
- **Layer 2 校正済み LLM judge** — 決定論的に判定できない説明の正確さ、欠落、明瞭さ、不確実性の表現。absolute score だけでなく blind pairwise 比較も使う。
- **Layer 3 human review** — judge と決定論的 scorer の不一致、low confidence、high severity、新しい failure category、閾値付近、fairness pair 不一致を queue へ送る。

## Release gate の 3 値

判定は `approved` / `blocked` / `undecidable` の 3 値にする。**2 値にしない**ことが設計上の要点になる。

`undecidable` は「まだ判断できない」であって pass ではない。judge が未校正、dataset が要件未満、非決定的な suite を 1 回しか走らせていない、infra 起因の失敗が混ざっている、のいずれかで発生する。`kind !== "blocked"` で通す実装は契約違反になる。

infra failure と model failure を区別し、model failure を retry で隠さない。

## Shadow と canary

shadow candidate は本番 request または redaction 済み trace を評価するが、利用者へ回答を返さず、本番 mutation を実行しない。`assertShadowPerformedNoMutation` が mutating tool call を検出して失敗させる。baseline と candidate が同じ本番環境へ二重に mutation する構成は禁止する。

canary は tenant / event / セッションの小さい割合に限定し、kill switch を持ち、閾値違反時は新規セッションを baseline へ自動 rollback する。rollback 理由と target version を audit に残す。

## 既知の限界 (Phase 1 時点)

- **runner も scorer も judge もまだ無い。** この Phase の成果物は契約とその機械的強制だけである。契約を満たす run を実際に生成するのは子 Issue の仕事になる。
- **calibration の手続きは定義したが、calibration set はまだ無い。** `judgeCalibrated` は現時点で呼び出し側が渡す boolean で、校正そのものを検証してはいない。
- **cost / latency の閾値に実測の裏付けが無い。** 閾値は呼び出し側が渡す形にしてあり、デフォルト値を置いていないのは、根拠のない数字をデフォルトとして配らないためである。
- **fairness pair の判定は「不一致率」までで、原因分析はしない。**

## 残りの Phase (一件一責務の分解)

Issue 2936 は Initiative なので、Phase 1 の次は一件一責務へ分解する。ここでは **分解そのものを
成果物として書き残す**。Issue として起票するかどうかは repository owner の判断に委ねる (未着手の
Issue を増やすこと自体がコストになるため、勝手には起票していない)。

| # | 責務 | 完了条件 | 依存 |
| --- | --- | --- | --- |
| A | offline runner | Issue 2911 の 1 scenario を Simulator / local mode で最後まで走らせ、`RunResult` を生成する | Phase 1 |
| B | 決定論的 scorer | problem score / checkpoint / service health / policy violation / forbidden side effect / timeout / cost / latency を採点する。既存の Problem Pack scoring を再利用し、AI 専用の重複 scorer を作らない | A |
| C | evidence と factuality | claim を tool call ID / request ID / state snapshot / score event / health probe へ結びつけ、unsupported claim 率と citation support 率を出す | A |
| D | golden dataset 100 件 | coverage matrix の 12 区分を実際に埋める。judge calibration set は分離する | Phase 1 |
| E | 校正済み judge | judge model / prompt / rubric を version 固定し、human-labeled set との一致を測る。校正未達を `judgeCalibrated: false` として扱う | D |
| F | CLI と CI gate | `tenkacloud eval run` / `eval gate`、JSON と人間向け report、PR では smoke suite・merge では full suite | A-E |
| G | human review queue | judge と scorer の不一致、low confidence、high severity、fairness pair 不一致を blind label へ送り、adjudication を dataset へ戻す | E |
| H | dashboard と alert | target / model / prompt / dataset / evaluator version 別の可視化と閾値 alert。既存の observability 経路を再利用する | F |
| I | shadow と canary | read-only gateway と dry-run projection、canary の kill switch と自動 rollback、rollback 理由の audit | F |

A から C までが最初の vertical slice で、ここまで揃って初めて「1 scenario が end-to-end で評価
できる」と言える。D と E が揃うまで release gate は `undecidable` を返し続ける — それは実装の
未完成ではなく、契約が意図した通りの状態になる。

## 関連

- Issue 2911 — Agent-only GameDay の制約・監査・採点 (最初の評価対象)
- Issue 2837 — 安全な agent operator
- `packages/ai-eval/` — この文書が説明している契約の実装
