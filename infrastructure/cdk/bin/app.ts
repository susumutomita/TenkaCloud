#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ControlPlaneStack } from '../lib/control-plane-stack';
import { AppPlaneStack } from '../lib/app-plane-stack';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT,
  region:
    process.env.CDK_DEFAULT_REGION ??
    process.env.AWS_REGION ??
    'ap-northeast-1',
};

const app = new cdk.App();

const controlPlane = new ControlPlaneStack(app, 'TenkaCloudControlPlane', {
  env,
  systemAdminEmail:
    app.node.tryGetContext('adminEmail') ?? 'admin@tenkacloud.io',
  auth0Domain:
    app.node.tryGetContext('auth0Domain') ??
    process.env.AUTH0_DOMAIN ??
    'tenkacloud-dev.us.auth0.com',
  auth0ClientId:
    app.node.tryGetContext('auth0ClientId') ??
    process.env.AUTH0_CLIENT_ID ??
    '',
  auth0ClientSecret:
    app.node.tryGetContext('auth0ClientSecret') ??
    process.env.AUTH0_CLIENT_SECRET ??
    '',
  auth0Audience:
    app.node.tryGetContext('auth0Audience') ??
    process.env.AUTH0_AUDIENCE ??
    'https://api.tenkacloud.io',
});

new AppPlaneStack(app, 'TenkaCloudAppPlane', {
  env,
  eventBusArn: controlPlane.eventBusArn,
});
