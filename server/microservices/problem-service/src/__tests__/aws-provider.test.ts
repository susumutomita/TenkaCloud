import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Problem } from "../types";

const mocks = vi.hoisted(() => ({
	stsSend: vi.fn(),
	cfSend: vi.fn(),
	s3Send: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", () => ({
	STSClient: class {
		send = mocks.stsSend;
	},
	AssumeRoleCommand: class {
		constructor(public readonly input: unknown) {}
	},
	GetCallerIdentityCommand: class {
		constructor(public readonly input: unknown) {}
	},
}));

vi.mock("@aws-sdk/client-cloudformation", () => ({
	CloudFormationClient: class {
		send = mocks.cfSend;
	},
	CreateStackCommand: class {
		constructor(public readonly input: unknown) {}
	},
	DeleteStackCommand: class {
		constructor(public readonly input: unknown) {}
	},
	DescribeStacksCommand: class {
		constructor(public readonly input: unknown) {}
	},
	DescribeStackResourcesCommand: class {
		constructor(public readonly input: unknown) {}
	},
	ListStacksCommand: class {
		constructor(public readonly input: unknown) {}
	},
	ValidateTemplateCommand: class {
		constructor(public readonly input: unknown) {}
	},
}));

vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		send = mocks.s3Send;
	},
	PutObjectCommand: class {
		constructor(public readonly input: unknown) {}
	},
}));

const problem: Problem = {
	id: "problem-1",
	title: "Test",
	type: "gameday",
	category: "security",
	difficulty: "medium",
	metadata: {
		author: "test",
		version: "1.0.0",
		createdAt: new Date().toISOString(),
	},
	description: {
		overview: "overview",
		objectives: [],
		hints: [],
	},
	deployment: {
		providers: ["aws"],
		templates: {
			aws: {
				type: "cloudformation",
				content: "Resources: {}",
			},
		},
		regions: {
			aws: ["ap-northeast-1"],
		},
		timeout: 1,
	},
	scoring: {
		type: "manual",
		path: "/manual",
		criteria: [],
		timeoutMinutes: 1,
	},
};

describe("AWSCloudProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("accessKeyId / roleArn が無い場合でも SDK default chain で STS が成功すれば valid とすべき", async () => {
		// SDK default chain (profile / SSO / instance role) を使うパス。AWS provider 内部
		// では credentials = undefined のまま STS Client を作るため、SDK が自動で chain を
		// 走る。ここでは STS GetCallerIdentity が成功する想定 = chain で creds が見つかった。
		mocks.stsSend.mockResolvedValueOnce({
			Account: "111122223333",
			Arn: "arn:aws:iam::111122223333:user/dev",
		});

		const { AWSCloudProvider } = await import("../providers/aws");
		const provider = new AWSCloudProvider();

		const credentials = {
			provider: "aws" as const,
			accountId: "",
			region: "ap-northeast-1",
		};
		const valid = await provider.validateCredentials(credentials);

		expect(valid).toBe(true);
		// 副作用: 空だった accountId が STS の応答で in-place に補完される。
		expect(credentials.accountId).toBe("111122223333");
	});

	it("STS GetCallerIdentity が失敗した場合は invalid を返すべき", async () => {
		mocks.stsSend.mockRejectedValueOnce(new Error("CredentialsProviderError"));

		const { AWSCloudProvider } = await import("../providers/aws");
		const provider = new AWSCloudProvider();

		const valid = await provider.validateCredentials({
			provider: "aws",
			accountId: "",
			region: "ap-northeast-1",
		});

		expect(valid).toBe(false);
	});

	it("roleArn がある場合は ExternalId 付きで AssumeRole して認証検証すべき", async () => {
		mocks.stsSend
			.mockResolvedValueOnce({
				Credentials: {
					AccessKeyId: "ASIA...",
					SecretAccessKey: "secret",
					SessionToken: "token",
				},
			})
			.mockResolvedValueOnce({
				Account: "123456789012",
				Arn: "arn:aws:sts::123456789012:assumed-role/Test/session",
			});

		const { AWSCloudProvider } = await import("../providers/aws");
		const provider = new AWSCloudProvider();

		const valid = await provider.validateCredentials({
			provider: "aws",
			accountId: "123456789012",
			region: "ap-northeast-1",
			roleArn: "arn:aws:iam::123456789012:role/TenkaCloudDeployRole",
			externalId: "tc-event-1-123456789012",
		});

		expect(valid).toBe(true);
		expect(mocks.stsSend).toHaveBeenCalledTimes(2);
		const assumeRoleCommand = mocks.stsSend.mock.calls[0][0] as {
			input: { ExternalId?: string };
		};
		expect(assumeRoleCommand.input.ExternalId).toBe(
			"tc-event-1-123456789012",
		);
	});

	it("CloudFormation でスタックを作成して CREATE_COMPLETE を待つべき", async () => {
		mocks.cfSend
			.mockResolvedValueOnce({ StackId: "stack-1" })
			.mockResolvedValueOnce({
				Stacks: [
					{
						StackName: "tc-stack",
						StackId: "stack-1",
						StackStatus: "CREATE_COMPLETE",
						Outputs: [{ OutputKey: "ConsoleUrl", OutputValue: "https://example.com" }],
					},
				],
			});

		const { AWSCloudProvider } = await import("../providers/aws");
		const provider = new AWSCloudProvider();

		const result = await provider.deployStack(
			problem,
			{
				provider: "aws",
				accountId: "123456789012",
				region: "ap-northeast-1",
				accessKeyId: "access",
				secretAccessKey: "secret",
			},
			{
				stackName: "tc-stack",
				region: "ap-northeast-1",
				timeoutSeconds: 1,
			},
		);

		expect(result.success).toBe(true);
		expect(result.stackId).toBe("stack-1");
		expect(result.outputs).toEqual({ ConsoleUrl: "https://example.com" });
	});
});
