import type { SemanticCandidate } from "./semantic-search";

// Match only public catalog fields. Synonyms connect everyday requests to authored
// technical terms; they never create problems or override hosting/filter constraints.
const concepts = [
  ["暗号", "cryptography", "encryption", "crypto"],
  ["障害", "復旧", "トラブル", "troubleshooting", "incident", "recovery"],
  ["監視", "monitoring", "observability", "cloudwatch"],
  ["権限", "認可", "permission", "authorization", "iam"],
  ["認証", "authentication", "login"],
  ["データベース", "database", "sql"],
  ["ネットワーク", "network", "vpc"],
  ["コンテナ", "container", "docker"],
  ["セキュリティ", "security", "脆弱性", "vulnerability"],
  ["サーバーレス", "serverless", "lambda"],
  ["コスト", "費用", "cost"],
] as const;
const noise = new Set([
  "問題",
  "練習",
  "学習",
  "勉強",
  "学び",
  "学ぶ",
  "たい",
  "したい",
  "する",
  "できる",
  "について",
  "ため",
  "から",
  "こと",
  "初心者",
  "向け",
  "入門",
  "教え",
  "探し",
  "the",
  "a",
  "an",
  "i",
  "want",
  "to",
  "learn",
  "practice",
  "please",
  "problem",
  "problems",
]);
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

export function rankPurpose(query: string, candidates: readonly SemanticCandidate[]) {
  const text = normalize(query);
  const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  const terms = [
    ...new Set(
      [...segmenter.segment(text)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment)
        .filter((term) => term.length > 1 && !noise.has(term)),
    ),
  ];
  const groups: readonly (readonly string[])[] = [
    ...concepts.filter((group) => group.some((term) => text.includes(term))),
    ...terms.map((term) => [term]),
  ];
  return candidates
    .map((candidate) => {
      const document = normalize(
        [candidate.name, candidate.summary, ...candidate.goals, ...candidate.tags].join(" "),
      );
      const matches = groups.filter((group) => group.some((term) => document.includes(term)));
      return { id: candidate.id, score: matches.length };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}
