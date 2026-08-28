# Problem cost-risk classification

The admin console does not calculate an AWS bill. It classifies resources from a problem's
CloudFormation template so an operator can notice standing resources and resource types that need
manual review before an event.

## Contract

- Do not store hourly, monthly, per-event-run, or region-specific dollar rates in this repository.
- `alwaysOn` means the resource can continue incurring charges while it remains provisioned. It is
  a teardown warning, not a price quote.
- `riskLevel` is a review priority. It is not comparable to an AWS invoice.
- Unknown CloudFormation resource types must remain visible as `unclassifiedResourceTypes`; never
  silently treat them as free.
- The operator must use current AWS pricing information for the selected region, account, purchase
  option, and expected usage when a monetary estimate is required.

## Maintenance

Update `packages/problem-cost/src/index.ts` only when one of these changes:

1. a problem introduces a CloudFormation resource type not yet classified;
2. AWS changes whether a resource incurs standing charges; or
3. a resource's operational risk changes materially (for example, a new independently billed
   component).

Every classification change needs a focused unit test. Price changes alone require no repository
change because no dollar rate is stored here.

For monetary planning, use the current AWS Price List or AWS Pricing Calculator, and compare the
result with actual Cost Explorer or billing data after a trial event. Free Tier and account-specific
discounts are outside this classifier.
