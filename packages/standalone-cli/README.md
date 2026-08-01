# @tenkacloud/cli

Install and operate TenkaCloud without cloning the monorepo.

```bash
npm install -g @tenkacloud/cli
tenkacloud init
aws login
tenkacloud deploy
```

`tenkacloud init` stores only non-secret configuration under the platform config directory:

- problem directory
- expected AWS account ID
- AWS region
- environment name

AWS credentials are never stored by this package. Every cloud command runs `aws sts get-caller-identity` first and refuses to continue when the logged-in account differs from the configured account.

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

## Runtime packaging

The npm tarball contains a prepared TenkaCloud runtime. On first use, the CLI expands that runtime into the user's cache directory, installs its locked dependencies with the Bun binary shipped as an npm dependency, and copies the configured problem directory into the isolated runtime workspace. Users do not need Git, a repository checkout, submodules, or a separate Bun installation.

The `prepack` script assembles the runtime from the monorepo immediately before publishing. Generated `node_modules`, `dist`, and CDK output directories are excluded from the tarball.
