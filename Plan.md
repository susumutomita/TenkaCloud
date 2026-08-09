# Issue #2765 — TenkaCloud Lite complete teardown

> Historical plan: #2959 later changed Lite DynamoDB to default deletion. Current behavior is
> `CDK_PARAM_RETAIN_DATA_TABLES=false`; retaining history requires an explicit deploy with `true`.
> The data-preserving assumptions below describe the original #2765 design and are superseded.

## Framing

- User outcome: a beginner can completely remove a TenkaCloud Lite deployment without manually
  guessing DynamoDB table or CloudWatch log-group names.
- Acceptance criteria:
  - `ACTION=destroy` remains the data-preserving teardown path.
  - an explicit `ACTION=destroy-all` path captures the exact DynamoDB table, CloudWatch LogGroup,
    Lambda function, and CodeBuild project physical resource IDs owned by the two Lite stacks
    before either stack is modified; deletes only those tables and exact/derived log groups; waits
    for table deletion; and fails closed when discovery, deletion, or verification fails;
  - the launcher CodeBuild log group is a CloudFormation-managed resource deleted with its stack;
  - the public cleanup checkpoint is emitted only after complete teardown succeeds;
  - launcher, getting-started, onboarding-video, and cleanup-drill copy distinguishes preservation
    from complete removal;
  - focused unit/CDK assertions, `make harness`, `make check-synth`, and `make before-commit` pass.
- Non-goals:
  - changing SaaS `make destroy-saas` retention behavior;
  - deleting CDK bootstrap resources;
  - deleting tables or log groups from another TenkaCloud environment;
  - making destructive data purge the default action.
- Affected planes and modes:
  - Lite operator CLI and launcher template;
  - Lite problem-deploy backend CodeBuild logging;
  - Lite cleanup onboarding fixture/video metadata;
  - SaaS behavior must remain unchanged.
- Data flow and ownership:
  - CloudFormation owns the two Lite stacks;
  - DynamoDB tables are retained after those stacks are deleted;
  - complete teardown must derive table physical IDs from those live stack resources before
    deletion, then carry that immutable list through teardown;
  - the launcher CodeBuild log group should be owned by the launcher stack;
  - retained explicit LogGroups are selected by their stack-owned physical IDs;
  - any default Lambda and CodeBuild log groups outside CloudFormation are derived from the
    corresponding stack-owned function/project physical IDs before stack deletion.
- Trust boundaries:
  - the launcher build role performs destructive AWS calls in the operator account;
  - no prefix-only or account-wide delete is allowed;
  - the explicit `destroy-all` selection is the non-interactive destructive confirmation.
- Physical impact:
  - CREATE an explicit launcher CloudWatch LogGroup resource;
  - UPDATE CodeBuild logging configuration and launcher action/build commands;
  - DELETE only captured Lite DynamoDB tables when `destroy-all` is selected;
  - NO-OP for SaaS teardown and normal Lite deploy/update behavior.
- Cost:
  - removing retained 1/1 PROVISIONED tables stops their standing capacity cost;
  - explicit log groups do not add a new logging workload and retain the existing short retention
    contract.
- Live AWS verification:
  - required once for actual stack-resource discovery, DynamoDB waiter behavior, CodeBuild logging
    order, launcher-stack deletion, and residual-resource inventory.
- Rollback and recovery:
  - `destroy` remains available when data must be retained;
  - discovery must complete before either stack is modified;
  - partial purge failure reports the exact table and exits non-zero; rerunning `destroy-all` after
    both stacks are gone cannot rediscover ownership and must not broaden its scope.

## Approach Registry

### A — Change every Lite table to `RemovalPolicy.DESTROY`

- family: CloudFormation retention policy
- hypothesis: stack deletion can remove all tables without a second purge phase.
- expectedEvidence: per-mode removal policy can be applied without changing SaaS templates.
- evidence: table constructs are shared with SaaS and currently encode intentional `RETAIN`.
- exactGap: this removes the required data-preserving `destroy` behavior or adds pervasive
  per-construct policy plumbing.
- status: disproved
- blockedReason: cannot provide both preserve and complete-removal actions for the same deployed
  stack without updating retention policy before teardown.
- retryCondition: product contract changes so Lite teardown is always destructive.
- adversarialFindings: accidental data loss becomes the default.

### B — Capture exact stack-owned IDs, purge retained resources, then destroy stacks

- family: operator CLI ownership manifest
- hypothesis: an explicit complete-teardown command can preserve the current CFn retention safety
  while deleting only resources proven to belong to the two Lite stacks. Purging before stack
  deletion keeps retry ownership evidence available if a destructive AWS call fails.
- expectedEvidence: tests observe two `list-stack-resources` calls before either `cdk destroy`,
  delete/wait calls only for captured `AWS::DynamoDB::Table` resources, exact
  `AWS::Logs::LogGroup` names, and default log names derived from captured Lambda/CodeBuild IDs,
  plus fail-closed behavior.
- evidence: the Lite CLI already owns stack ordering and has an injected AWS runner seam. Default
  log-group names are `/aws/lambda/<function physical ID>` and
  `/aws/codebuild/<project physical ID>`; explicit LogGroups expose their names as physical IDs.
- exactGap: live AWS execution and residual-resource inventory remain unverified locally.
- status: selected
- blockedReason:
- retryCondition:
- adversarialFindings: discovery pagination and partial failure must not silently produce a
  successful checkpoint. Moving the shared problem-deploy project to a new managed log group would
  alter SaaS and still leave existing default groups, so only the launcher group becomes managed.

### C — Delete every table or log group with a `tenkacloud` prefix

- family: account-wide orphan sweep
- hypothesis: naming conventions are enough to identify Lite resources after stack deletion.
- expectedEvidence: prefix is globally unique to one Lite environment.
- evidence: the existing retained-table reporter intentionally finds all TenkaCloud tables.
- exactGap: prefixes overlap Lite environments and SaaS resources.
- status: disproved
- blockedReason: resource ownership is not proven.
- retryCondition: none; exact ownership evidence is required for destructive cleanup.
- adversarialFindings: cross-environment and SaaS data deletion.

### D — Teach manual deletion in the cleanup video

- family: operator documentation
- hypothesis: users can safely identify and remove leftovers in the AWS console.
- expectedEvidence: a short deterministic sequence with no ambiguous resource selection.
- evidence: physical names are generated and the current report is account-wide.
- exactGap: beginners must make a destructive ownership judgment the platform can make more
  reliably before stack deletion.
- status: disproved
- blockedReason: error-prone UX and incomplete automation.
- retryCondition: only as temporary recovery documentation for a failed automated purge.
- adversarialFindings: tutorial viewers can delete unrelated data.

## Completion audit

- Implemented the selected exact-ownership approach in the Lite CLI and launcher template.
- Preserved `destroy` as the non-data-deleting path and made `destroy-all` explicit.
- Added fail-closed handling for unsupported CodeBuild action overrides and documented the
  mandatory launcher-template update for existing deployments.
- Verified focused tests, generated documentation, duplication baseline, architecture harness,
  CDK synth/IAM checks, infrastructure coverage, all-workspace tests, typecheck, and production
  builds.
- exactGap: the configured AWS session expired, so no live deployment/destruction was run.
  The PR must retain one-time verification steps for resource discovery, DynamoDB wait behavior,
  launcher log migration/deletion, and residual DynamoDB/CloudWatch inventory.
