import { choices, questions } from "./questions.js";
export const modes = [
  {
    id: "foundation",
    label: "基礎",
    eyebrow: "CLOUD FOUNDATIONS",
    description: "やりたいこと → クラウドの役割",
  },
  {
    id: "http",
    label: "HTTP",
    eyebrow: "PROTOCOL RECOGNITION",
    description: "合成した平文・表示用デコード例",
  },
  {
    id: "aws",
    label: "AWS API",
    eyebrow: "API RECOGNITION",
    description: "合成 EC2 Query API 要求・デコード済み",
  },
];
export function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function shuffle(list, rng) {
  const output = [...list];
  for (let i = output.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}
export function objective(mode, seed) {
  if (mode === "http")
    return {
      id: "request",
      label: "HTTP/1.1 の要求",
      title: "HTTP の要求を拾え",
      detail: "レスポンス・他の通信・判別できないものは見送る",
      mark: "⇄",
    };
  if (mode === "aws")
    return {
      id: "start",
      label: "EC2 の起動要求",
      title: "EC2 起動要求を拾え",
      detail: "DryRun の権限確認・停止・参照は見送る",
      mark: "▷",
    };
  const choice = choices[(seed >>> 0) % choices.length];
  return {
    id: choice.id,
    label: choice.label,
    title: {
      compute: "計算する仕事を拾え",
      storage: "保存する仕事を拾え",
      network: "通信をつなぐ仕事を拾え",
      identity: "権限を絞る仕事を拾え",
      resilience: "障害に備える仕事を拾え",
    }[choice.id],
    detail: `${choice.name}が対象。それ以外は見送る`,
    mark: choice.mark,
  };
}
function protocolQuestions() {
  const matches = ["GET", "HEAD", "POST", "PUT"].flatMap((method, i) =>
    [0, 1, 2].map((n) => {
      const path = ["/learn/cloud", "/assets/guide.svg", "/practice/notes"][n];
      const body = '{"note":"hello"}';
      const content = `${method} ${path} HTTP/1.1\r\nHost: practice.invalid\r\n${["POST", "PUT"].includes(method) ? `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}` : "\r\n"}`;
      return {
        id: `http-request-${i}-${n}`,
        title: "平文の表示例",
        prompt: content,
        code: true,
        category: "request",
        match: true,
        why: "メソッド、リクエスト先、HTTP/1.1 の順の開始行があるため、HTTP/1.1 の要求と分かります。応答の開始行とは形式が異なります。",
        source: "https://www.rfc-editor.org/rfc/rfc9112.html#section-3",
      };
    }),
  );
  const other = [
    [
      "response",
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello",
      "HTTP ですが、ステータスコードを含む応答です。この回の対象は要求なので見送ります。",
    ],
    [
      "response",
      "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
      "先頭が HTTP バージョンとステータスコードなので応答です。対象は HTTP の要求です。",
    ],
    [
      "smtp",
      "EHLO mail.practice.invalid\r\n",
      "EHLO は SMTP の挨拶コマンドです。HTTP の要求行ではありません。",
    ],
    [
      "dns",
      "DNS decoded\nQNAME: practice.invalid\nQTYPE: A",
      "これは表示用にデコードした DNS 問い合わせの例です。HTTP の要求ではありません。",
    ],
    [
      "opaque",
      "TLS application_data\nEncrypted payload:\n<opaque>",
      "暗号文だけから HTTP の要求とは判定できません。TLS を使っているだけでは対象になりません。",
    ],
    [
      "transport",
      "TCP dst_port: 443\nFlags: ACK\nPayload: <not shown>",
      "443 番ポートや TCP ヘッダーだけでは、HTTP の要求かどうか分かりません。見送ります。",
    ],
  ].map(([category, prompt, why], i) => ({
    id: `http-other-${i}`,
    title: "合成した表示例",
    prompt,
    why,
    code: true,
    category,
    match: false,
    source:
      category === "smtp"
        ? "https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.1.1"
        : "https://www.rfc-editor.org/rfc/rfc9112.html",
  }));
  return { matches, other };
}
function apiQuestions() {
  const cases = [
    [
      "StartInstances",
      false,
      true,
      "指定された停止済みの EBS-backed EC2 を起動する要求です。実際に成功したかは、この要求だけでは分かりません。",
    ],
    [
      "StartInstances",
      true,
      false,
      "同じ StartInstances でも DryRun=true は権限確認だけです。起動処理は行わないので、この回では見送ります。",
    ],
    [
      "StopInstances",
      false,
      false,
      "StopInstances は停止の要求です。起動ではありません。また、この要求だけでは停止が成功したとは分かりません。",
    ],
    [
      "DescribeInstances",
      false,
      false,
      "DescribeInstances はインスタンス情報を参照する要求です。起動処理ではありません。",
    ],
  ];
  const all = cases.flatMap(([operation, dryRun, match, why], index) =>
    [0, 1, 2, 3].map((n) => {
      const instance = `i-${(0x123456 + n).toString(16).padStart(17, "0")}`;
      return {
        id: `aws-${index}-${n}`,
        title: "EC2 Query API · 合成要求",
        prompt: `Action=${operation}\nInstanceId.1=${instance}\nDryRun=${dryRun}`,
        code: true,
        category: `${operation}:${dryRun}`,
        match,
        why,
        operation,
        parameters: { "InstanceId.1": instance, DryRun: dryRun },
        source: `https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_${operation}.html`,
      };
    }),
  );
  return { matches: all.filter((q) => q.match), other: all.filter((q) => !q.match) };
}
export function buildDeck(mode, seed, cycle = 0) {
  const rng = random((seed + Math.imul(cycle, 2654435761)) >>> 0);
  const target = objective(mode, seed);
  const pool =
    mode === "foundation"
      ? {
          matches: questions
            .filter((q) => q.answer === target.id)
            .map((q) => ({ ...q, match: true, category: q.answer })),
          other: questions
            .filter((q) => q.answer !== target.id)
            .map((q) => ({ ...q, match: false, category: q.answer })),
        }
      : mode === "http"
        ? protocolQuestions()
        : apiQuestions();
  const matches = shuffle(pool.matches, rng);
  // Round-robin distractor categories makes every condition family appear before recycling.
  const categories = shuffle([...new Set(pool.other.map((q) => q.category))], rng);
  const buckets = categories.map((category) =>
    shuffle(
      pool.other.filter((q) => q.category === category),
      rng,
    ),
  );
  const others = [];
  for (let i = 0; i < Math.max(...buckets.map((b) => b.length)); i++)
    for (const bucket of buckets) if (bucket[i]) others.push(bucket[i]);
  const deck = [];
  for (let i = 0; i < others.length; i++) {
    const pair = [{ ...matches[i % matches.length] }, { ...others[i] }];
    if (rng() > 0.5) pair.reverse();
    deck.push(...pair);
  }
  // Always offer an immediately recognizable target in the first three objects.
  if (!deck.slice(0, 3).some((q) => q.match)) throw new Error("Missing opening target");
  return deck;
}
