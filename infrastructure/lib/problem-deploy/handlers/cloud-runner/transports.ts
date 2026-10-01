/** Structural, asynchronous ports. An SDK adapter must construct commands explicitly. */
export interface AssumedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

export interface SsmTransport {
  getParameter(input: { readonly Name: string; readonly WithDecryption: true }): Promise<{
    readonly Parameter?: {
      readonly ARN?: string;
      readonly Type?: string;
      readonly Value?: string;
    };
  }>;
}

export interface StsTransport {
  assumeRole(input: {
    readonly RoleArn: string;
    readonly RoleSessionName: string;
    readonly ExternalId: string;
    readonly DurationSeconds: 900;
  }): Promise<{
    readonly Credentials?: {
      readonly AccessKeyId?: string;
      readonly SecretAccessKey?: string;
      readonly SessionToken?: string;
      readonly Expiration?: Date;
    };
  }>;
}

export interface StackTag {
  readonly Key: string;
  readonly Value: string;
}

export interface StackDescription {
  readonly StackId?: string;
  readonly StackName?: string;
  readonly StackStatus?: string;
  readonly Tags?: readonly { readonly Key?: string; readonly Value?: string }[];
  readonly Outputs?: readonly { readonly OutputKey?: string; readonly OutputValue?: string }[];
}

export interface CloudFormationTransport {
  describeStacks(input: { readonly StackName: string }): Promise<{
    readonly Stacks?: readonly StackDescription[];
  }>;
  createStack(input: {
    readonly StackName: string;
    readonly TemplateBody: string;
    readonly Parameters: readonly {
      readonly ParameterKey: string;
      readonly ParameterValue: string;
    }[];
    readonly Capabilities: readonly ("CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM")[];
    readonly Tags: readonly StackTag[];
    readonly ClientRequestToken: string;
    readonly OnFailure: "DO_NOTHING";
    readonly TimeoutInMinutes: 30;
  }): Promise<{ readonly StackId?: string }>;
  deleteStack(input: {
    readonly StackName: string;
    readonly ClientRequestToken: string;
  }): Promise<unknown>;
}

export interface CloudRunnerDependencies {
  readonly ssm: (region: string) => SsmTransport;
  readonly sts: StsTransport;
  /** Credentials are mandatory; adapters must never use the ambient AWS provider chain here. */
  readonly cloudFormation: (input: {
    readonly region: string;
    readonly accountId: string;
    readonly credentials: AssumedCredentials;
  }) => CloudFormationTransport;
  readonly now?: () => number;
}
