/** Pure, deterministic game rules. No storage, clock, network or DOM. */
export const choices = [
  { id: "compute", mark: "▷", label: "コードを動かす", name: "コンピュート" },
  { id: "storage", mark: "▤", label: "データを保存", name: "ストレージ" },
  { id: "network", mark: "⇄", label: "通信をつなぐ", name: "ネットワーク" },
  { id: "identity", mark: "⌘", label: "権限をしぼる", name: "アイデンティティ" },
  { id: "resilience", mark: "◇", label: "障害に備える", name: "レジリエンス" },
];

export const questions = [
  [
    "写真の置き場所",
    "公開サイトの画像ファイルを保存したい。サーバーで処理する必要はない。まず選ぶのは？",
    "storage",
    "画像のような静的ファイルにはオブジェクトストレージ。保存とコードの実行は別の役割です。",
  ],
  [
    "アップロードのその後",
    "画像が届いたら縮小処理を実行したい。保存先は用意済み。追加する役割は？",
    "compute",
    "ファイルを変換するコードを実行するのはコンピュート。保存先だけでは変換処理は動きません。",
  ],
  [
    "読むだけのアプリ",
    "アプリには特定の保存領域の読み取りだけが必要。削除権限まで渡さないために見直すのは？",
    "identity",
    "必要な対象・操作だけを許可する最小権限が基本。読み取り専用なら削除や書き込みを許可しません。",
  ],
  [
    "内側だけのデータベース",
    "データベースへの経路を、同じ仮想ネットワークのアプリからだけに限定したい。設計するのは？",
    "network",
    "プライベートな経路と通信ルールで接続元を限定します。別途、データベース認証も必要です。",
  ],
  [
    "一つの拠点が止まったら",
    "一つの稼働拠点が停止してもサービスを続けたい。複数拠点に冗長化するのは何のため？",
    "resilience",
    "独立した拠点に分散すると、一つの拠点の障害に備えられます。切り替えの設計と確認も必要です。",
  ],
  [
    "記録を残す",
    "処理の実行環境はある。監査用ログファイルを後から読み返せるよう保持する役割は？",
    "storage",
    "後から使うデータを保持するのはストレージ。保存期間やアクセス権限も合わせて決めます。",
  ],
  [
    "リクエストを振り分ける",
    "すでに動いている複数の Web サーバーへ、入口で通信を振り分けたい。必要な役割は？",
    "network",
    "ロードバランサーは通信を複数のサーバーに振り分けます。コードを実行するサーバーとは別の役割です。",
  ],
  [
    "夜中の集計",
    "毎晩、売上データを計算するプログラムを動かしたい。データの保存先はある。必要な役割は？",
    "compute",
    "集計プログラムを実行するためにコンピュートを使います。起動時刻を決める仕組みも組み合わせます。",
  ],
  [
    "期限のある作業",
    "外部の担当者が一日だけ作業する。必要な操作と利用期限を設定するのはどの分野？",
    "identity",
    "操作範囲と有効期限を絞った権限を使います。作業が終わった後のアクセスを残さないことも大切です。",
  ],
  [
    "消してしまったデータ",
    "誤削除したデータを昨日の状態に戻したい。バックアップと復元手順を用意する主な目的は？",
    "resilience",
    "バックアップは障害や誤操作からの復旧のため。保存するだけでなく、実際に復元できるか確認します。",
  ],
  [
    "動画をそのまま保管",
    "配信する動画ファイルをそのまま保管したい。変換処理や配信経路は別に用意する。必要な役割は？",
    "storage",
    "ファイルそのものを保持する役割はストレージ。変換はコンピュート、配信経路はネットワークが担います。",
  ],
  [
    "アプリ専用の身分証",
    "アプリからクラウド資源へアクセスする。誰として何を許可するか、ロールを設計する分野は？",
    "identity",
    "ロールでアプリの身元と許可する操作を定義します。人の強い権限をそのまま渡さないようにします。",
  ],
  [
    "名前から行き先へ",
    "利用者が入力したドメイン名をサーバーの IP アドレスに対応づけたい。DNS が担う役割は？",
    "network",
    "DNS は名前から接続先を見つけるための仕組みです。ファイルの保存やアプリの計算はしません。",
  ],
  [
    "注文を受け付ける",
    "注文内容を検証して合計金額を計算する API を動かしたい。必要な中心の役割は？",
    "compute",
    "入力を検証し、金額を計算するコードの実行はコンピュートの役割です。",
  ],
  [
    "戻せるリリース",
    "更新で不具合が出たとき、直前の正常な版へ戻す手順を準備したい。主な目的は？",
    "resilience",
    "切り戻し手順は障害の影響を短くする備えです。正常な版と戻す条件を事前に決めます。",
  ],
  [
    "編集してよい人だけ",
    "同じチームでも閲覧者と編集者を分けたい。利用者ごとに許可する操作を管理する分野は？",
    "identity",
    "認可で利用者が実行できる操作を分けます。ログインできることと編集できることは別です。",
  ],
  [
    "サーバー同士の道",
    "アプリサーバーから内部 API へパケットが届くよう、ルートを設定したい。扱う分野は？",
    "network",
    "ルーティングは通信の経路を決めます。到達できても、API を使うための認証・認可は別途必要です。",
  ],
  [
    "処理をまとめて実行",
    "大量のファイルを解析するバッチプログラムがある。保存済みファイルに対してコードを動かす役割は？",
    "compute",
    "解析の計算を実行するのはコンピュート。保存されたファイルは入力データです。",
  ],
  [
    "再起動のあとにも",
    "アプリを再起動してもアップロード済みの文書を残したい。永続的に保持する役割は？",
    "storage",
    "実行中のメモリだけに置かず、永続ストレージに保存します。必要な耐久性やバックアップも検討します。",
  ],
  [
    "復旧できるか試す",
    "障害時の復旧手順は書けた。定期的な復旧訓練で、実際に戻せるか確認する分野は？",
    "resilience",
    "復旧の手順や所要時間は試して初めて確かめられます。訓練で見つけた問題を手順に反映します。",
  ],
].map(([title, prompt, answer, why], id) => ({ id, title, prompt, answer, why }));

export function shuffled(seed) {
  let value = seed >>> 0;
  const deck = [...questions];
  for (let i = deck.length - 1; i > 0; i--) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const j = value % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function createGame(mode = "timed", seed = 726) {
  return {
    mode,
    seed,
    deck: shuffled(seed),
    phase: "ready",
    previous: null,
    elapsed: 0,
    fall: 0,
    index: 0,
    score: 0,
    combo: 0,
    best: 0,
    correct: 0,
    history: [],
    feedback: null,
  };
}
export function current(state) {
  return state.deck[state.index % state.deck.length];
}
export function fallDuration(state) {
  return Math.max(9000, 14000 - state.correct * 200);
}
export function start(state) {
  if (state.phase === "ready") state.phase = "playing";
}
export function pause(state) {
  if (!["playing", "feedback"].includes(state.phase)) return;
  state.previous = state.phase;
  state.phase = "paused";
}
export function resume(state) {
  if (state.phase !== "paused") return;
  state.phase = state.previous;
  state.previous = null;
}
function resolve(state, answer) {
  if (state.phase !== "playing") return false;
  const question = current(state);
  const correct = answer === question.answer;
  state.combo = correct ? state.combo + 1 : 0;
  state.best = Math.max(state.best, state.combo);
  const points = correct ? 100 + Math.min(state.combo - 1, 5) * 20 : 0;
  state.score += points;
  state.correct += Number(correct);
  state.feedback = { question, answer, correct, points };
  state.history.push(state.feedback);
  state.phase = "feedback";
  return true;
}
export function answer(state, id) {
  if (!choices.some((choice) => choice.id === id)) return false;
  return resolve(state, id);
}
export function next(state) {
  if (state.phase !== "feedback") return;
  state.index++;
  state.fall = 0;
  state.feedback = null;
  state.phase = "playing";
}
export function tick(state, milliseconds) {
  if (state.phase !== "playing" || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
  if (state.mode === "learn") return;
  const delta = Math.min(milliseconds, 75000 - state.elapsed, fallDuration(state) - state.fall);
  state.elapsed += delta;
  state.fall += delta;
  if (state.elapsed >= 75000) {
    state.phase = "finished";
    return;
  }
  if (state.fall >= fallDuration(state)) resolve(state, null);
}
export function finish(state) {
  if (["playing", "feedback"].includes(state.phase)) state.phase = "finished";
}
