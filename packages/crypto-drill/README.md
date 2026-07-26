# @tenkacloud/crypto-drill

暗号分野の段階学習ドリルのフォーマットと、SHA-256 ドリル本体 (15 節)。participant-portal の
`/learn/sha256` がこのパッケージだけを読んで画面を組み立てる。

## 信頼境界 (先に読む)

**このドリルの採点は自己学習のフィードバックであり、信頼できる採点ではない。**

- 期待値は SPA の bundle に載って学習者の手元へ配られる。devtools から正解を読める。
- 進捗は学習者の localStorage にある。手で書き換えて達成済みにできる。

どちらも教材として意図した設計になっている。学習者が自分を騙す動機が無いので、期待値を
サーバへ隠す複雑さを持ち込む理由がない。代わりに、次を守る。

- 合否をスコア・順位・修了判定・資格の根拠に **使わない**。
- 得点に効く判定が要るときは、期待値を配らないサーバ側の採点を別に用意する
  (problem-deploy backend の flag 採点と同じ構え)。この package を流用しない。

## 2 層構造

| 層 | 場所 | 責務 |
| --- | --- | --- |
| ドリルフォーマット | `src/drill/` | アルゴリズムに依存しない型・自動採点・進捗・段階ヒント・AI プロンプト組み立て |
| SHA-256 | `src/sha256/` | 全中間値を保持する参照実装 (trace) と 15 節の本文・図解・課題 |

SHA-1 / HMAC / PBKDF2 / AES などを足すときは、`src/<algorithm>/` に参照実装と節を書き、
`src/drill/` には触らない。

## 期待値は参照実装から生成する

節の期待値・図解の値・真理値表は、すべて `traceSha256` の出力から起こしている。教材側に
定数を手書きしないので、「解説の図と採点の正解がずれる」種類の事故が構造的に起きない。

参照実装そのものは 2 方向から検証している。

- 既知テストベクタ (空文字 / `abc` / `hello world` / 55 / 56 / 64 byte / UTF-8) との一致
- 定数表 `K` / `H` を素数の立方根・平方根から実際に導出しての一致 (`test/constants.test.ts`)

`test/drill-content.test.ts` は 15 節すべてを走査し、ja/en の欠落、期待値の正規形、選択肢の
正誤バランス、ヒント番号の連番、そして「期待値を提出したら全課題が合格する」ことを検査する。

## 学習者のコードは実行しない

`kind: "implementation"` の課題は「手元で関数を書き、示された複数の入力に対する出力を貼る」
形で採点する。ブラウザ内で学習者のコードを `eval` することはない (プラットフォーム全体で
禁止しており、教材のためにその境界は緩めない)。任意の 6 入力に正しく答えるには実際に動く
実装が必要なので、採点の意味は保たれる。

## AI サポートはプロンプトを組み立てるだけ

`buildCoachPrompt` は節と課題の文脈を埋め込んだプロンプト文字列を返す。プラットフォームから
LLM を呼ばない (`/tenka-drill` skill と同じ方式)。組み立てたプロンプトには **正解値を含めない**
ので、`mode: "hint"` で貼った先が答えを漏らすことはない。

## 使い方

```ts
import {
  SHA256_DRILL,
  emptyProgress,
  gradeTask,
  recordAttempt,
  renderProgressBar,
} from "@tenkacloud/crypto-drill";

let progress = emptyProgress(SHA256_DRILL.id);
const task = SHA256_DRILL.sections[0].tasks[0];
const result = gradeTask(task, { kind: "value", answers: { abc: "616263" } });
progress = recordAttempt(progress, task.id, result.passed);
renderProgressBar(1, SHA256_DRILL.sections.length); // "█□□□□□□□□□□□□□□"
```
