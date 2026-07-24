// Golden composite Azure (Bicep) target — Issue #2743 materialization.
// Source of truth for the sibling azure.json (a hand-verified precompile of this exact file):
// the metadata.json target entry points at azure.json so this problem deploys where no `bicep`
// CLI is available (the platform's materializer fails closed rather than compiling at deploy
// time when `bicep` is absent from PATH). Reserved runtime: declared and validated, never
// deployed in CI. The deploy body emits an AzureUrl output for the composite-probe scorer.
output AzureUrl string = 'https://azure.example.invalid'
