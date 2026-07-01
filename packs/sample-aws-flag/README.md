# Sample AWS flag pack

The smallest problem that actually deploys and scores end-to-end.

`sample-flag` is an AWS/CloudFormation Challenge whose deploy body stands up:

- one `AWS::SSM::Parameter` holding a per-deploy random flag `TC{...}` (the value is
  injected at deploy time via the `FlagSeed` parameter, so it cannot be guessed from
  the public name prefix), and
- a least-privilege `ParticipantViewerRole` a competitor assumes to read that one
  parameter.

The competitor reads the parameter (Console or `aws ssm get-parameter`), submits the
`TC{...}` value in the Participant Portal, and earns the points. Scoring is the
built-in `flag` kind reading the `FlagValue` stack output.

Zero-cost: a single SSM Standard-tier parameter, no EC2 / VPC / public endpoint.

Use it to smoke-test the deploy -> flag-submission -> score pipeline, or as a worked
starting point for authoring your own Challenge.
