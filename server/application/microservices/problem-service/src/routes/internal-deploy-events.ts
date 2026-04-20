/**
 * Internal Deploy Events Receiver
 *
 * ProblemDeployPlane (CodeBuild ScriptJob) が EventBridge に送る
 * `problem.deploy.completed` / `problem.deploy.failed` を受けて
 * DynamoDB の DeploymentJob status を更新する。
 *
 * Invoke path: EventBridge rule → API Destination (HTTPS POST) → このルート
 * 認証: `X-TenkaCloud-Internal-Token` header と INTERNAL_EVENT_TOKEN の一致で認証
 *
 * Event payload は EventBridge 生データをそのまま転送する想定:
 *   {
 *     "detail-type": "problem.deploy.completed" | "problem.deploy.failed",
 *     "source": "tenkacloud.problem-deploy-plane",
 *     "detail": {
 *       "deploymentKey": "<eventId>:<problemId>:<jobId>",
 *       "jobOutput": { "tenantData": { "deployStatus": "completed", "stackName": "...", ... } }
 *                  | { "deployStatus": "failed" }
 *     }
 *   }
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { decodeDeploymentKey, EventDetailType } from "@tenkacloud/events";
import { logger, gamedayJobRepo } from "./admin-shared";

const internalDeployEventsRoutes = new Hono();

const eventBridgePayloadSchema = z.object({
	"detail-type": z.enum([
		EventDetailType.PROBLEM_DEPLOY_COMPLETED,
		EventDetailType.PROBLEM_DEPLOY_FAILED,
	]),
	source: z.string().optional(),
	detail: z.object({
		deploymentKey: z.string().min(1),
		jobOutput: z
			.object({
				deployStatus: z.enum(["completed", "failed"]).optional(),
				tenantData: z
					.object({
						deployStatus: z.enum(["completed", "failed"]).optional(),
						stackName: z.string().optional(),
						stackId: z.string().optional(),
						errorReason: z.string().optional(),
					})
					.optional(),
			})
			.optional(),
	}),
});

function authenticate(token: string | undefined): boolean {
	const expected = process.env.INTERNAL_EVENT_TOKEN;
	if (!expected) {
		// 本番では必ずトークンを設定する。未設定時は受理しない。
		return process.env.NODE_ENV !== "production";
	}
	return token === expected;
}

internalDeployEventsRoutes.post(
	"/deploy-events",
	zValidator("json", eventBridgePayloadSchema),
	async (c) => {
		const token = c.req.header("X-TenkaCloud-Internal-Token");
		if (!authenticate(token)) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const payload = c.req.valid("json");
		const detailType = payload["detail-type"];
		const key = decodeDeploymentKey(payload.detail.deploymentKey);
		if (!key) {
			logger.warn(
				{ deploymentKey: payload.detail.deploymentKey },
				"Invalid deploymentKey",
			);
			return c.json({ error: "Invalid deploymentKey" }, 400);
		}

		const tenantData = payload.detail.jobOutput?.tenantData;
		const isFailedEvent =
			detailType === EventDetailType.PROBLEM_DEPLOY_FAILED;

		try {
			if (isFailedEvent) {
				await gamedayJobRepo.updateStatus(
					key.eventId,
					key.problemId,
					key.jobId,
					"failed",
					{
						error:
							tenantData?.errorReason ??
							"Deployment failed (no detail from ProblemDeployPlane)",
						result: tenantData?.stackName
							? {
									success: false,
									stackName: tenantData.stackName,
									stackId: tenantData.stackId,
									startedAt: new Date(),
									completedAt: new Date(),
								}
							: undefined,
					},
				);
			} else {
				await gamedayJobRepo.updateStatus(
					key.eventId,
					key.problemId,
					key.jobId,
					"completed",
					{
						result: {
							success: true,
							stackName: tenantData?.stackName,
							stackId: tenantData?.stackId,
							outputs: {},
							startedAt: new Date(),
							completedAt: new Date(),
						},
					},
				);
			}
			return c.json({ ok: true }, 200);
		} catch (error) {
			logger.error(
				{ error, deploymentKey: payload.detail.deploymentKey },
				"Failed to update deployment job status",
			);
			return c.json({ error: "Failed to update job status" }, 500);
		}
	},
);

export { internalDeployEventsRoutes };
