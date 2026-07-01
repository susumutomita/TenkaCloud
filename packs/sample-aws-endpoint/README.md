# Sample AWS reachable-endpoint pack

The smallest problem that stands up a **real, reachable** endpoint and is scored on
its uptime.

`sample-uptime` is an AWS/CloudFormation Battle whose deploy body creates:

- a Node.js Lambda that returns HTTP `200`,
- a **public Lambda Function URL** (`AuthType: NONE`) in front of it, and
- a least-privilege `ParticipantViewerRole`.

The platform reads the Function URL from the `ServiceUrl` stack output; the
`uptime-flat` scorer probes `ServiceUrl` (`/health`) every tick and awards points
while it returns `200`. Near-zero cost (Lambda free tier; no EC2 / VPC).

## Verification status

- **AWS leg — verified.** The deploy body is cfn-lint clean (0 errors / 0 warnings),
  and the uptime scoring cases pass through the pack test-runner.
- **GCP / Azure / Sakura — not in this pack yet.** A cross-cloud composite is the
  headline differentiator, but each non-AWS target's deploy body and its
  output-key contract (e.g. Sakura AppRun returns `BaseUrl`) can only be confirmed
  against a real per-cloud deploy. They will be added one provider at a time, each
  verified live, rather than shipped as unverified scaffolds.

This pack is the verified AWS anchor that the composite grows from.
