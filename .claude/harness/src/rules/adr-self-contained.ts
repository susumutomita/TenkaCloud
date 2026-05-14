import type { Finding, Rule, RuleContext } from "../types.ts";

const ADR_HTML_RE = /^docs\/architecture\/adr-[a-z0-9-]+\.html$/i;

const CHAT_CONTEXT_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /今回(?:の|は|だけ)?/g, label: "今回" },
  { pattern: /本タスク/g, label: "本タスク" },
  { pattern: /このターン/g, label: "このターン" },
  { pattern: /先ほど|さきほど/g, label: "先ほど" },
  { pattern: /このチャット|このスレッド/g, label: "このチャット" },
  { pattern: /順次反映|順次更新/g, label: "順次反映" },
  { pattern: /TODO:\s*あとで(?:差し替え|更新|追記|書く)/g, label: "TODO: あとで" },
  { pattern: /Phase\s+\d+\.\d+\s+で書く/g, label: "Phase X.Y で書く" },
  { pattern: /(?:Claude|Codex|私|あなた)\s*が\s*(?:書いた|決めた|提案)/g, label: "一人称" },
  { pattern: /Claude\s*(?:担当|側の提案|=\s*ADR 改訂|\(=)/g, label: "Claude 担当" },
  { pattern: /user\s+担当/g, label: "user 担当" },
];

export function findAdrSelfContainedViolations(path: string, content: string): readonly Finding[] {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  let inPre = false;
  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine.replaceAll(/<code\b[^>]*>.*?<\/code>/gis, "");
    const preStart = line.search(/<pre\b[^>]*>/i);
    const preEnd = line.search(/<\/pre>/i);
    if (inPre) {
      if (preEnd >= 0) {
        line = line.slice(preEnd + "</pre>".length);
        inPre = false;
      } else {
        continue;
      }
    }
    if (preStart >= 0) {
      if (preEnd > preStart) {
        line = `${line.slice(0, preStart)}${line.slice(preEnd + "</pre>".length)}`;
      } else {
        line = line.slice(0, preStart);
        inPre = true;
      }
    }
    for (const { pattern, label } of CHAT_CONTEXT_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) continue;
      const matchedText = match[0];
      findings.push({
        ruleId: "adr-self-contained",
        severity: "error",
        filePath: path,
        line: index + 1,
        match: matchedText,
        message:
          "ADR は OSS readers 向けの正本として self-contained に書く。chat 文脈 / 段階的反映 metadata / AI agent との役割分担メモは ADR 本文に残さない。",
        recommendation: `該当表現 (${label}: ${matchedText}) を、読者が単独で理解できる設計判断・責務分界・履歴に書き換えてください。`,
      });
      break;
    }
  }
  return findings;
}

export const adrSelfContained: Rule = {
  id: "adr-self-contained",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!ADR_HTML_RE.test(path)) continue;
      findings.push(...findAdrSelfContainedViolations(path, ctx.readFile(path)));
    }
    return findings;
  },
};
