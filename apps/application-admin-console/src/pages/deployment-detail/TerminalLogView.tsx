import type { LogLine } from "../../lib/deploy-phases";

/**
 * Terminal-style log renderer。Netlify の expanded log view を模す。
 * - 左 gutter: 行番号 (right-aligned, dim)
 * - 中央 gutter: timestamp
 * - 右: log text (section header は cyan)
 */
export function TerminalLogView({ lines }: { lines: readonly LogLine[] }) {
  // 行番号は append-only な log なので index で問題ないが、key には text + ts を
  // 組み合わせた stable な値を使う (biome の useArrayKey 規約)。同一行が重複するケース
  // のために locallyUnique counter を ts+text で消化する。
  const keys = (() => {
    const seen = new Map<string, number>();
    return lines.map((line) => {
      const base = `${line.timestamp ?? ""}|${line.header ? "H" : "L"}|${line.text}`;
      const dup = seen.get(base) ?? 0;
      seen.set(base, dup + 1);
      return dup === 0 ? base : `${base}#${dup}`;
    });
  })();
  return (
    <div className="tc-terminal-log" data-testid="terminal-log">
      <pre className="tc-terminal-log-pre">
        {lines.map((line, idx) => {
          const number = String(idx + 1).padStart(3, " ");
          const ts = line.timestamp ?? "";
          return (
            <div
              key={keys[idx]}
              className={line.header ? "tc-log-line tc-log-header" : "tc-log-line"}
            >
              <span className="tc-log-number">{number}</span>
              <span className="tc-log-ts">{ts && `${ts}:`}</span>
              <span className="tc-log-text">{line.text}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
