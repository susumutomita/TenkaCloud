export const DEV_MOCK_ONBOARDING_DESCRIPTION_JA = [
  "動画のあと、動画で説明したTenkaCloudの仕組みを3問で振り返り、問題文・ヒント・接続先・flag提出をTenkaCloudの実際の問題画面で体験する。",
  "",
  "#### この画面で確かめること",
  "",
  "1. TenkaCloudは紙の知識クイズではなく、実際に動く環境で調査や修正を練習する",
  "2. Battleは同時に得点を競い、Challengeは自分のペースで進める",
  "3. Local、Lite、SaaSの違いと、DockerがLocalで必要になる理由",
  "4. 困ったら「ヒントを公開する」を押し、確認画面からヒントを開く",
  "5. 問題がRunningになったら接続先を開き、環境を調べたり直したりする",
  "6. 見つけた`TC{...}`形式のflagを提出して得点する",
  "",
  "#### はじめて出てくる言葉",
  "",
  "- **クラウド**: インターネット越しに、サーバーや保存場所を必要な分だけ使う仕組み",
  "- **Docker**: アプリ、設定、必要なソフトをひとまとめにし、同じ練習環境を手元のパソコンでも再現しやすくする仕組み。Localを選ぶときに使う",
  "- **問題環境**: その問題専用に起動する、壊しても本番のサービスへ影響しない練習場所",
  "- **flag**: 問題を解けた証拠として提出する`TC{...}`形式の文字列",
  "",
  "下の6問はすべて、実際のTenkaCloudと同じflag入力・ヒント公開・採点の仕組みを使う。4問目ではヒントを実際に開いて答えを確認する。完了後は独立したローカルモード問題で本物の環境を試せる。",
].join("\n");

export const DEV_MOCK_ONBOARDING_INSTRUCTIONS_JA =
  "動画を見たあと、6つの提出欄を順番に進める。わからないときは各欄の「ヒントを公開する」を押す。4問目では必ずヒントを開き、TenkaCloudのヒント公開操作を体験する。";

export const DEV_MOCK_ONBOARDING_DESCRIPTION_EN = [
  "After the video, review three TenkaCloud concepts, then use the real problem UI to practise reading, revealing a hint, opening an endpoint, and submitting a flag.",
  "",
  "#### What this walkthrough checks",
  "",
  "1. TenkaCloud uses real running environments, not a paper knowledge quiz",
  "2. Battle is a simultaneous score competition; Challenge is self-paced",
  "3. The difference between Local, Lite, and SaaS, and why Local uses Docker",
  "4. How to select Reveal hint and confirm the reveal when you get stuck",
  "5. How to open the endpoint after the problem is Running and investigate or repair it",
  "6. How to submit the `TC{...}` flag you found and score",
  "",
  "#### Terms introduced here",
  "",
  "- **Cloud**: a way to use servers and storage over the internet as needed",
  "- **Docker**: packages an app, settings, and required software so Local mode can recreate the same practice environment on your computer",
  "- **Problem environment**: an isolated practice area created for one problem, safe to investigate or repair without affecting a production service",
  "- **Flag**: a `TC{...}` value submitted as proof that you solved the problem",
  "",
  "All six checks use the same flag input, hint reveal, and scoring mechanisms as a real TenkaCloud problem. Check 4 deliberately asks you to reveal a hint. Afterward, use the separate local-mode problem for a real environment.",
].join("\n");

export const DEV_MOCK_ONBOARDING_INSTRUCTIONS_EN =
  "Watch the video, then complete all six flag rows in order. Use Reveal hint whenever you get stuck. On check 4, reveal the hint so you experience the real hint flow.";
