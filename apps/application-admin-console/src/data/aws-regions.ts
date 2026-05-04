/**
 * AWS リージョンのカタログ。問題 deploy 先の Select に出す。
 * 日本国内向けに東京・大阪・米国系を優先表示。必要に応じて追加する。
 */
export interface AwsRegion {
  readonly code: string;
  readonly label: string;
}

export const AWS_REGIONS: readonly AwsRegion[] = [
  { code: "ap-northeast-1", label: "ap-northeast-1 (東京)" },
  { code: "ap-northeast-3", label: "ap-northeast-3 (大阪)" },
  { code: "us-east-1", label: "us-east-1 (バージニア北部)" },
  { code: "us-west-2", label: "us-west-2 (オレゴン)" },
  { code: "eu-west-1", label: "eu-west-1 (アイルランド)" },
];

export const DEFAULT_AWS_REGION: AwsRegion = AWS_REGIONS[0];
