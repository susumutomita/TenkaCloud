export type Severity = "error" | "warning" | "info";

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly filePath: string;
  readonly line?: number;
  readonly match?: string;
  readonly message: string;
  readonly recommendation: string;
}

export interface RuleContext {
  /** Repository-relative paths (POSIX separators) the rule should inspect. */
  readonly files: readonly string[];
  /**
   * Every tracked repository file, including files outside a staged-only run. Graph rules use
   * this to follow unchanged callers into a changed transitive dependency.
   */
  readonly allFiles?: readonly string[];
  /** Returns file contents for a given repo-relative path. */
  readonly readFile: (path: string) => string;
}

export interface Rule {
  readonly id: string;
  readonly severity: Severity;
  readonly check: (ctx: RuleContext) => readonly Finding[];
}
