export {
  analyzeRepository,
  formatImprovementReportAsMarkdown,
  hasFindingsAtOrAboveSeverity,
  shouldAnalyzeFile,
} from './tech-debt-loop';
export {
  analyzeArchitecture,
  formatArchitectureReportAsMarkdown,
  getArchitectureHarnessAuthoritativePaths,
  hasArchitectureFindingsAtOrAboveSeverity,
  shouldAnalyzeArchitectureFile,
} from './architecture-harness';
export type {
  DebtFinding,
  DebtHotspot,
  DebtSeverity,
  ImprovementReport,
  RepositoryFile,
} from './tech-debt-loop';
export type {
  ArchitectureFile,
  ArchitectureFinding,
  ArchitectureReport,
  ArchitectureSeverity,
} from './architecture-harness';
