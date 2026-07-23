export function normalizeEnglishForSpeech(text: string): string {
  return text
    .replace(/\bwe'll\b/gi, "we will")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bTenkaCloud\b/g, "Tenka Cloud")
    .replace(/\bLite\b/g, "Light")
    .replace(/\bAWS\b/g, "A W S")
    .replace(/\bCloudFormation\b/g, "Cloud Formation")
    .replace(/\bCodeBuild\b/g, "Code Build")
    .replace(/\bExternalId\b/g, "External I D")
    .replace(/\bAssumeRole\b/g, "Assume Role")
    .replace(/\bSUCCEEDED\b/g, "succeeded")
    .replace(/\bURLs?\b/g, (value) => (value.endsWith("s") ? "U R Ls" : "U R L"));
}

export function normalizeJapaneseForSpeech(text: string): string {
  return text
    .replace(/\bCloudFormation\b/g, "クラウドフォーメーション")
    .replace(/\bCodeBuild\b/g, "コードビルド")
    .replace(/\bIAM Role\b/gi, "アイエーエム ロール")
    .replace(/\bCDK\b/g, "シーディーケー")
    .replace(/\bstack\b/gi, "スタック")
    .replace(/\bproject\b/gi, "プロジェクト")
    .replace(/\bdeploy\b/gi, "デプロイ");
}
