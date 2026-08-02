# @tenkacloud/cli

Install and operate TenkaCloud without cloning the monorepo.

Requires Node.js 24+ and [Bun](https://bun.sh) on `PATH`. The bundled runtime is
TypeScript, so Bun executes it. This package does not vendor Bun: the `bun` npm
package downloads its binary from a `postinstall`, which is the kind of
install-time script the platform's dependency audit rejects, and which never
runs in a checkout installed with `--ignore-scripts`. `tenkacloud` names the
missing prerequisite and stops, rather than failing part-way through a deploy.

```bash
npm install -g bun          # skip if you already have it
npm install -g @tenkacloud/cli
tenkacloud init
aws login
tenkacloud doctor
tenkacloud deploy
```

`tenkacloud init` stores only non-secret configuration under the platform config directory:

- problem directory
- expected AWS account ID
- allowed AWS operator role ARN
- AWS region
- environment name

AWS credentials are never stored by this package. Every cloud command runs `aws sts get-caller-identity` first and refuses to continue unless both the account and assumed IAM role match the configured values. IAM users and unexpected roles are rejected before the bundled runtime is invoked.

## Commands

```bash
tenkacloud doctor
tenkacloud problems validate
tenkacloud deploy
tenkacloud status
tenkacloud destroy
tenkacloud destroy --purge-retained-data
tenkacloud config path
```

## Problem directory boundary

The complete problem tree is inspected before copying. Symbolic links at any depth, paths that resolve outside the configured root, and special files such as sockets, FIFOs, or devices are rejected. The copied staging tree is inspected again before it atomically replaces the runtime problem directory.

## Runtime packaging

The npm tarball contains a prepared TenkaCloud runtime. On first use, the CLI expands that runtime into the user's cache directory, installs its locked dependencies with the Bun binary shipped as an npm dependency, and copies the configured problem directory into the isolated runtime workspace. Users do not need Git, a repository checkout, submodules, or a separate Bun installation.

The `prepack` script assembles the runtime from the monorepo immediately before publishing. Generated `node_modules`, `dist`, and CDK output directories are excluded from the tarball.
