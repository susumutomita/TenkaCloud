#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ControlPlaneStack } from '../lib/control-plane';

const app = new cdk.App();

// CDK コンテキストから取得する。渡し方:
//   cdk deploy -c systemAdminEmail=admin@example.com
// または cdk.json の context セクションに記載する。
const systemAdminEmail = app.node.tryGetContext('systemAdminEmail') as string | undefined;
if (!systemAdminEmail) {
  throw new Error(
    'systemAdminEmail が設定されていません。\n' +
    '  cdk deploy -c systemAdminEmail=admin@example.com\n' +
    'または cdk.json の context に "systemAdminEmail" を追加してください。',
  );
}

new ControlPlaneStack(app, 'ControlPlaneStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
  systemAdminEmail,
  systemAdminRoleName: app.node.tryGetContext('systemAdminRoleName') as string | undefined,
  // 'false' を明示的に渡した場合のみ有効化（デフォルトは無効でコスト節約）
  disableAPILogging: app.node.tryGetContext('disableAPILogging') !== 'false',
});
