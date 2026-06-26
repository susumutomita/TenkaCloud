# Local play with Kumo

Local play deploys one real `flag` problem to
[Kumo](https://github.com/sivchari/kumo), starts a local scoring API, and runs
the Participant Portal without an AWS account.

## Prerequisites

- Docker with Compose
- Bun
- AWS CLI (used by the problem's discovery command)

## Start

```bash
make local
```

The default problem is `hello-world`. To select another problem:

```bash
make local PROBLEM=hello-world
```

Open <http://127.0.0.1:5175> and log in with any non-empty key. The problem
instructions include an AWS CLI command pointed at Kumo. Read the deployed
resource's value and submit it in the portal.

Local play supports one problem at a time and only `scoring.kind: "flag"`.
Unsupported scoring kinds and missing CloudFormation outputs fail explicitly;
there is no mock flag fallback.

The current materializer supports `AWS::SSM::Parameter` and `AWS::IAM::Role`.
Kumo does not preload AWS-managed IAM policies, so those attachments are
reported and skipped; inline role policies are created.

## Operations

```bash
make local-up
make local-status
make local-evaluate FLAG='TC{...}'
make local-down
```

Override ports with `KUMO_PORT` and `LOCAL_API_PORT`. Override the image with
`KUMO_IMAGE`; the default is pinned by digest in `docker-compose.kumo.yml`.
