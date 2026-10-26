const value = (x) => (typeof x === "string" ? x : JSON.stringify(x));
const SPECIAL = {
  "Policy:S3/BucketPublicAccessGranted": [
    "ファイル一覧が、全員向けの設定に",
    "一覧の公開指定です。オブジェクト内容の公開とは別で、他の保護設定で防がれる場合もあります。",
  ],
  RDSPubliclyAccessible: [
    "社内DBを、外から接続可能な設定に",
    "社内専用という条件と異なる指定です。実際に接続できるかは、通信の保護設定にも依存します。",
  ],
  RDSIAMAuthDisabled: [
    "DBのIAM認証を、使わない設定に",
    "IAMで本人確認する構成にfalseを指定しています。DBのパスワード認証を無効にする意味ではありません。",
  ],
  EC2SecurityGroupPublicSSH: [
    "管理用ポートの接続元が、全IPv4に",
    "0.0.0.0/0は全IPv4を表し、管理元限定の範囲を超えます。接続可否は他の制御にも依存します。",
  ],
  "Stealth:IAMUser/CloudTrailLoggingDisabled": [
    "本番の監査記録を止める指定",
    "記録が必要な本番trailを停止する指定です。廃止済みtrailの整理とは異なります。",
  ],
  LambdaFunctionUrlPublicAccess: [
    "社内APIのIAM認証を外す指定",
    "AuthType:NONEはIAM認証を必須にせず、表示されたAWS_IAMの構成と異なります。",
  ],
  S3LifecycleRapidExpiration: [
    "監査ログの保持期間を短くする指定",
    "指定された失効日数が、表示された最低保持期間を満たしません。",
  ],
};
const NORMAL = {
  "Policy:S3/BucketPublicAccessGranted": [
    "一覧の公開範囲を、広げない指定",
    "privateは所有者向けの設定で、今回の社内限定の条件に合います。",
  ],
  RDSPubliclyAccessible: [
    "DBを、社内向けのままにする指定",
    "falseは公開可能な設定にしない指定です。今回は社内だけで使う条件に合います。",
  ],
  RDSIAMAuthDisabled: [
    "DBで、IAMの本人確認を有効に",
    "trueはIAM認証を有効にする指定で、今回の構成に合います。",
  ],
  EC2SecurityGroupPublicSSH: [
    "接続元は、管理用ネットワークだけ",
    "192.0.2.0/24は今回の管理元です。全IPv4の0.0.0.0/0とは異なります。",
  ],
  "Stealth:IAMUser/CloudTrailLoggingDisabled": [
    "止めるのは、廃止済みの記録",
    "今回の整理対象retired-trailです。本番production-auditの記録は止めません。",
  ],
  LambdaFunctionUrlPublicAccess: [
    "呼び出しには、IAMの本人確認が必要",
    "AWS_IAMはAWSの認証情報による確認を必要にする指定で、社内APIの条件に合います。",
  ],
  S3LifecycleRapidExpiration: [
    "監査ログを、必要な期間残す指定",
    "365日の指定は、今回の最低保持期間を満たしています。",
  ],
  IAMRoleTrustPolicyModified: [
    "この役割を使える相手は、自社",
    "指定された111122223333は、今回の自社アカウントです。",
  ],
  S3BucketPolicyExternalAccess: [
    "データの読み取り先は、自社",
    "指定された111122223333は、今回の共有先の範囲内です。",
  ],
};
SPECIAL.IAMRoleTrustPolicyModified = [
  "この役割を使える相手が、外部に",
  "信頼先は自社111122223333だけ。今回は外部444455556666を指定しています。",
];
SPECIAL.S3BucketPolicyExternalAccess = [
  "データの読み取り先が、外部に",
  "共有先は自社111122223333だけ。今回は外部444455556666を指定しています。",
];
const MEANING = {
  s3: "ファイル置き場",
  iam: "操作権限",
  ec2: "仮想サーバー",
  rds: "データベース",
  lambda: "プログラム実行",
  cloudtrail: "操作の記録",
};
const FAMILY = {
  dns: "要確認の宛先を含むDNS観測",
  network: "通常条件と異なる通信の観測",
  runtime: "業務用途と異なる実行時の観測",
  runtime_custom: "業務用途と異なる実行時の観測",
  malware: "ファイル検査で要確認の結果",
  cloudtrail: "想定した操作範囲と異なる観測",
  s3_data: "想定したデータ利用と異なる観測",
  rds: "通常のDB利用と異なる観測",
  kubernetes: "想定した権限・用途と異なる観測",
  sequence: "複数の要確認の兆候が重なる観測",
  ai: "表示した防御条件と異なるAI観測",
  configuration: "保護条件と異なる構成変更",
};
export function explanationCard(q) {
  const c = q.context,
    field = q.fields?.[0]?.[0] ?? q.payload.split(":")[0];
  const expected =
    c.kind !== "evidence" ? c.allowed : c.operator === "gt" ? `${c.threshold}以下` : q.normalValue;
  const generic = q.teachingNote?.split("。")[0];
  const chosen = q.danger ? SPECIAL[q.scenarioId] : NORMAL[q.scenarioId];
  return {
    headline:
      chosen?.[0] ??
      (!q.danger
        ? "今回の値は、表示された条件どおり"
        : (FAMILY[q.evidenceFamily] ?? `${q.operation}：表示した条件と不一致`)),
    operation: q.operation,
    meaning: MEANING[q.serviceId] ?? q.service,
    danger: q.danger,
    field,
    actual: value(c.actual),
    expected: value(expected),
    expectedLabel: c.kind === "evidence" && c.operator === "eq" ? "正常の例" : "この対象の条件",
    reason:
      chosen?.[1] ??
      (!q.danger ? "表示された対象・用途の範囲内です。" : `${generic ?? q.briefReason}。`),
    policy: c.policy,
    fullReason: q.why,
    wire: q.wire,
    source: q.source,
  };
}
