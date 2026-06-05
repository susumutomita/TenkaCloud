# @TenkaCloud/admin-console-ios

SwiftUI native admin app for the SaaS Control Plane.

This is the first native slice of `apps/admin-console`. It does not embed the
React SPA in a web view. Instead, it talks to the same Control Plane contracts:

- Cognito Hosted UI OAuth Code + PKCE through `ASWebAuthenticationSession`
- Memory-only bearer tokens, with refresh-token revoke on sign-out
- Tenant list, tenant creation, and tenant deprovision calls
- Tenant detail metadata, including Application Plane links from `tenantConfig`
- App Intent shortcut: "Open TenkaCloud Admin"

## Required Cognito callback

Add this callback URL to the Control Plane Cognito UserPoolClient:

```text
tenkacloud-admin://auth/callback
```

Infrastructure edits are intentionally not included here because CDK / IAM /
CloudFormation ownership stays with the repository owner.

## Local verification

The package is self-contained and has no external Swift dependencies.

```sh
bun run --filter @TenkaCloud/admin-console-ios test
bun run --filter @TenkaCloud/admin-console-ios build
```

Equivalent SwiftPM commands:

```sh
swift run TenkaCloudAdminCoreChecks
swift build
```

## Running in Xcode

Open `TenkaCloudAdmin.xcodeproj` in Xcode 16 or newer, select the
`TenkaCloudAdmin` scheme, and run it on an iOS simulator.

The Xcode project uses the local Swift package product
`TenkaCloudAdminCore`, so the app and CLI checks share the same API and OAuth
code.

The app asks for:

- Cognito domain: `https://<domain>.auth.<region>.amazoncognito.com`
- Client ID: the Control Plane user pool app client ID
- API base URL: the Control Plane API URL from `runtime-config.json`
- Scope: defaults to `openid email profile`

## Current scope

This app currently covers the System Admin / Control Plane workflow. The
Tenant Admin competition workflow in `apps/application-admin-console` remains a
web SPA for now and can be added as the next native slice.
