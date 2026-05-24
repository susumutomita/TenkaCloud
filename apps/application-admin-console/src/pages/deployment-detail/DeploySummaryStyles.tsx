/**
 * Component-scoped CSS。Cloudscape primitive で表現しきれない terminal-style
 * log の grid と code styling だけをここで閉じる。 旧 dark-background summary
 * card 用 CSS は #1091 で Cloudscape Header に揃えたため撤去済。
 */
export function DeploySummaryStyles() {
  return (
    <style>{`
.tc-phase-header {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}
.tc-phase-name {
  font-weight: 600;
}
.tc-phase-status {
  margin-left: auto;
}
.tc-terminal-log {
  background: #0f1419;
  color: #e8eaed;
  padding: 16px;
  border-radius: 8px;
  max-height: 80vh;
  overflow: auto;
}
.tc-terminal-log-pre {
  margin: 0;
  font-family: "SF Mono", Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}
.tc-log-line {
  display: grid;
  grid-template-columns: 4ch 11ch 1fr;
  gap: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.tc-log-number {
  text-align: right;
  color: #5a6470;
  font-variant-numeric: tabular-nums;
}
.tc-log-ts {
  color: #8a99a8;
  font-variant-numeric: tabular-nums;
}
.tc-log-text {
  color: #e8eaed;
}
.tc-log-header .tc-log-text {
  color: #66d9ef;
  font-weight: 600;
}
`}</style>
  );
}
